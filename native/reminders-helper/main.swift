import EventKit
import Foundation

enum HelperError: LocalizedError {
    case accessDenied
    case invalidArguments(String)
    case listNotFound
    case reminderNotFound

    var errorDescription: String? {
        switch self {
        case .accessDenied:
            return "미리 알림 전체 접근 권한이 필요합니다. 시스템 설정 > 개인정보 보호 및 보안 > 미리 알림에서 Watchpup을 허용해주세요."
        case let .invalidArguments(message):
            return message
        case .listNotFound:
            return "선택한 미리 알림 목록을 찾지 못했습니다."
        case .reminderNotFound:
            return "미리 알림 항목을 찾지 못했습니다."
        }
    }
}

@main
struct WatchpupRemindersHelper {
    static func main() async {
        do {
            let output = try await run(arguments: Array(CommandLine.arguments.dropFirst()))
            try writeJSON(output)
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            FileHandle.standardError.write(Data((message + "\n").utf8))
            Foundation.exit(1)
        }
    }

    private static func run(arguments: [String]) async throws -> Any {
        guard let command = arguments.first else {
            throw HelperError.invalidArguments("명령이 없습니다.")
        }
        let store = EKEventStore()
        guard try await requestAccess(store) else {
            throw HelperError.accessDenied
        }

        switch command {
        case "lists":
            let allReminders = await fetchReminders(store, predicate: store.predicateForReminders(in: nil))
            let grouped = Dictionary(grouping: allReminders, by: { $0.calendar.calendarIdentifier })
            let rows: [[String: Any]] = store.calendars(for: .reminder)
                .map { calendar -> [String: Any] in
                    let reminders = grouped[calendar.calendarIdentifier] ?? []
                    return [
                        "id": calendar.calendarIdentifier,
                        "name": calendar.title,
                        "account": calendar.source.title,
                        "openCount": reminders.filter { !$0.isCompleted }.count,
                        "totalCount": reminders.count,
                    ]
                }
                .sorted { lhs, rhs in
                    let left = "\(lhs["account"] as? String ?? "")/\(lhs["name"] as? String ?? "")"
                    let right = "\(rhs["account"] as? String ?? "")/\(rhs["name"] as? String ?? "")"
                    return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
                }
            return rows

        case "tasks":
            guard arguments.count >= 3 else {
                throw HelperError.invalidArguments("tasks에는 목록 ID와 완료 포함 여부가 필요합니다.")
            }
            let listID = arguments[1]
            let includeCompleted = arguments[2] == "true"
            guard let calendar = store.calendar(withIdentifier: listID) else {
                throw HelperError.listNotFound
            }
            let predicate = includeCompleted
                ? store.predicateForReminders(in: [calendar])
                : store.predicateForIncompleteReminders(
                    withDueDateStarting: nil,
                    ending: nil,
                    calendars: [calendar]
                )
            let reminders = await fetchReminders(store, predicate: predicate)
            return reminders.map { reminder in
                [
                    "id": reminder.calendarItemIdentifier,
                    "name": reminder.title ?? "",
                    "body": reminder.notes ?? "",
                    "completed": reminder.isCompleted,
                    "dueAt": dateString(reminder.dueDateComponents?.date),
                    "createdAt": dateString(reminder.creationDate),
                    "updatedAt": dateString(reminder.lastModifiedDate),
                    "listId": calendar.calendarIdentifier,
                    "listName": calendar.title,
                    "account": calendar.source.title,
                ] as [String: Any]
            }

        case "set-completed":
            guard arguments.count >= 3 else {
                throw HelperError.invalidArguments("set-completed에는 항목 ID와 완료 여부가 필요합니다.")
            }
            guard let reminder = store.calendarItem(withIdentifier: arguments[1]) as? EKReminder else {
                throw HelperError.reminderNotFound
            }
            reminder.isCompleted = arguments[2] == "true"
            if !reminder.isCompleted { reminder.completionDate = nil }
            try store.save(reminder, commit: true)
            return ["ok": true]

        case "append-link":
            guard arguments.count >= 4 else {
                throw HelperError.invalidArguments("append-link에는 항목 ID, 이름, URL이 필요합니다.")
            }
            guard let reminder = store.calendarItem(withIdentifier: arguments[1]) as? EKReminder else {
                throw HelperError.reminderNotFound
            }
            guard let url = URL(string: arguments[3]), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
                throw HelperError.invalidArguments("http 또는 https 링크만 추가할 수 있습니다.")
            }
            let before = (reminder.notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !before.localizedCaseInsensitiveContains(url.absoluteString) {
                let title = arguments[2].trimmingCharacters(in: .whitespacesAndNewlines)
                    .replacingOccurrences(of: "[", with: "")
                    .replacingOccurrences(of: "]", with: "")
                let link = "[\(title.isEmpty ? url.host ?? "링크" : title)](\(url.absoluteString))"
                reminder.notes = before.isEmpty ? link : "\(before)\n\(link)"
                try store.save(reminder, commit: true)
            }
            return ["ok": true]

        default:
            throw HelperError.invalidArguments("지원하지 않는 명령입니다: \(command)")
        }
    }

    private static func requestAccess(_ store: EKEventStore) async throws -> Bool {
        try await store.requestFullAccessToReminders()
    }

    private static func fetchReminders(_ store: EKEventStore, predicate: NSPredicate) async -> [EKReminder] {
        await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                continuation.resume(returning: reminders ?? [])
            }
        }
    }

    private static func dateString(_ date: Date?) -> Any {
        guard let date else { return NSNull() }
        return ISO8601DateFormatter().string(from: date)
    }

    private static func writeJSON(_ value: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}
