import Darwin
import Foundation

final class ReminderKitBridge {
    struct HierarchyEntry {
        let parentID: String?
        let childIDs: [String]
        let depth: Int
    }

    enum BridgeError: LocalizedError {
        case unavailable
        case reminderNotFound
        case unsupported
        case saveFailed(String)

        var errorDescription: String? {
            switch self {
            case .unavailable:
                return "이 macOS 버전에서는 Reminder 서브태스크 기능을 사용할 수 없습니다."
            case .reminderNotFound:
                return "부모 Reminder를 찾지 못했습니다."
            case .unsupported:
                return "현재 macOS의 ReminderKit API가 예상 형식과 다릅니다."
            case let .saveFailed(message):
                return message
            }
        }
    }

    private let reminderKitPath = "/System/Library/PrivateFrameworks/ReminderKit.framework/ReminderKit"
    private let reminderKitInternalPath = "/System/Library/PrivateFrameworks/ReminderKitInternal.framework/ReminderKitInternal"
    private var didLoad = false

    func hierarchy(listIdentifier: String) -> [String: HierarchyEntry] {
        guard let list = targetList(identifier: listIdentifier),
              let reminders = callObjectWithError(list, "fetchRemindersAndSubtasksWithError:") as? [NSObject] else {
            return [:]
        }

        var allIDs = Set<String>()
        var parentByID: [String: String] = [:]
        var children: [String: [String]] = [:]
        for reminder in reminders {
            guard let id = reminderID(from: callObject(reminder, "objectID")) else { continue }
            allIDs.insert(id)
            let parentID = reminderID(from: callObject(reminder, "parentReminderID"))
            if let parentID {
                parentByID[id] = parentID
                children[parentID, default: []].append(id)
            }
        }

        var depthCache: [String: Int] = [:]
        func depth(for id: String, visited: Set<String> = []) -> Int {
            if let cached = depthCache[id] { return cached }
            guard !visited.contains(id), let parentID = parentByID[id], allIDs.contains(parentID) else {
                depthCache[id] = 0
                return 0
            }
            let value = min(depth(for: parentID, visited: visited.union([id])) + 1, 8)
            depthCache[id] = value
            return value
        }

        return Dictionary(uniqueKeysWithValues: allIDs.map { id in
            (id, HierarchyEntry(parentID: parentByID[id], childIDs: children[id] ?? [], depth: depth(for: id)))
        })
    }

    func addSubtask(title: String, parentReminderID: String) throws -> String {
        guard loadFrameworks(),
              let parentObjectID = objectID(uuidString: parentReminderID, entityName: "REMCDReminder"),
              let store = makeStore() else {
            throw BridgeError.unavailable
        }
        guard let parent = callObjectWithError(store, "fetchReminderWithObjectID:error:", parentObjectID) as? NSObject else {
            throw BridgeError.reminderNotFound
        }
        guard let saveRequest = makeSaveRequest(store: store),
              let parentChange = callObject(saveRequest, "updateReminder:", parent) as? NSObject,
              let context = callObject(parentChange, "subtaskContext"),
              let newChange = callObject(
                saveRequest,
                "addReminderWithTitle:toReminderSubtaskContextChangeItem:",
                title as NSString,
                context
              ) as? NSObject else {
            throw BridgeError.unsupported
        }

        var error: NSError?
        guard callSave(saveRequest, error: &error) else {
            throw BridgeError.saveFailed(error?.localizedDescription ?? "서브태스크 저장에 실패했습니다.")
        }
        guard let id = reminderID(from: callObject(newChange, "objectID")) else {
            throw BridgeError.saveFailed("생성된 서브태스크 ID를 확인하지 못했습니다.")
        }
        return id
    }

    private func targetList(identifier: String) -> NSObject? {
        guard loadFrameworks(), let store = makeStore(),
              let lists = callObjectWithError(store, "fetchListsForEventKitBridgingWithError:") as? [NSObject] else {
            return nil
        }
        return lists.first { reminderID(from: callObject($0, "objectID")) == identifier }
    }

    private func loadFrameworks() -> Bool {
        if didLoad { return true }
        guard dlopen(reminderKitPath, RTLD_NOW) != nil else { return false }
        _ = dlopen(reminderKitInternalPath, RTLD_NOW)
        didLoad = true
        return true
    }

    private func makeStore() -> NSObject? {
        guard let type = NSClassFromString("REMStore") as? NSObject.Type else { return nil }
        return type.init()
    }

    private func makeSaveRequest(store: NSObject) -> NSObject? {
        guard let type = NSClassFromString("REMSaveRequest") as? NSObject.Type else { return nil }
        return callObject(type.init(), "initWithStore:", store) as? NSObject
    }

    private func objectID(uuidString: String, entityName: String) -> NSObject? {
        guard let uuid = NSUUID(uuidString: uuidString),
              let type = NSClassFromString("REMObjectID") as? NSObject.Type else { return nil }
        return callObject(type.init(), "initWithUUID:entityName:", uuid, entityName as NSString) as? NSObject
    }

    private func reminderID(from object: AnyObject?) -> String? {
        guard let object = object as? NSObject else { return nil }
        let raw = callObject(object, "stringRepresentation").map(String.init(describing:)) ?? String(describing: object)
        guard let slash = raw.lastIndex(of: "/") else { return nil }
        let id = raw[raw.index(after: slash)...].trimmingCharacters(in: CharacterSet(charactersIn: " <>"))
        return id.isEmpty ? nil : id
    }

    private func callObject(_ object: NSObject, _ selectorName: String) -> AnyObject? {
        let selector = NSSelectorFromString(selectorName)
        guard object.responds(to: selector), let implementation = object.method(for: selector) else { return nil }
        typealias Function = @convention(c) (AnyObject, Selector) -> AnyObject?
        return unsafeBitCast(implementation, to: Function.self)(object, selector)
    }

    private func callObject(_ object: NSObject, _ selectorName: String, _ argument: AnyObject) -> AnyObject? {
        let selector = NSSelectorFromString(selectorName)
        guard object.responds(to: selector), let implementation = object.method(for: selector) else { return nil }
        typealias Function = @convention(c) (AnyObject, Selector, AnyObject) -> AnyObject?
        return unsafeBitCast(implementation, to: Function.self)(object, selector, argument)
    }

    private func callObject(
        _ object: NSObject,
        _ selectorName: String,
        _ first: AnyObject,
        _ second: AnyObject
    ) -> AnyObject? {
        let selector = NSSelectorFromString(selectorName)
        guard object.responds(to: selector), let implementation = object.method(for: selector) else { return nil }
        typealias Function = @convention(c) (AnyObject, Selector, AnyObject, AnyObject) -> AnyObject?
        return unsafeBitCast(implementation, to: Function.self)(object, selector, first, second)
    }

    private func callObjectWithError(_ object: NSObject, _ selectorName: String) -> AnyObject? {
        let selector = NSSelectorFromString(selectorName)
        guard object.responds(to: selector), let implementation = object.method(for: selector) else { return nil }
        typealias Function = @convention(c) (AnyObject, Selector, UnsafeMutablePointer<NSError?>?) -> AnyObject?
        var error: NSError?
        return unsafeBitCast(implementation, to: Function.self)(object, selector, &error)
    }

    private func callObjectWithError(_ object: NSObject, _ selectorName: String, _ argument: AnyObject) -> AnyObject? {
        let selector = NSSelectorFromString(selectorName)
        guard object.responds(to: selector), let implementation = object.method(for: selector) else { return nil }
        typealias Function = @convention(c) (AnyObject, Selector, AnyObject, UnsafeMutablePointer<NSError?>?) -> AnyObject?
        var error: NSError?
        return unsafeBitCast(implementation, to: Function.self)(object, selector, argument, &error)
    }

    private func callSave(_ object: NSObject, error: inout NSError?) -> Bool {
        let selector = NSSelectorFromString("saveSynchronouslyWithError:")
        guard object.responds(to: selector), let implementation = object.method(for: selector) else { return false }
        typealias Function = @convention(c) (AnyObject, Selector, UnsafeMutablePointer<NSError?>?) -> Bool
        return unsafeBitCast(implementation, to: Function.self)(object, selector, &error)
    }
}
