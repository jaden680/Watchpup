import EventKit
import Foundation

enum HelperError: LocalizedError {
    case accessDenied
    case calendarAccessDenied
    case invalidArguments(String)
    case listNotFound
    case reminderNotFound

    var errorDescription: String? {
        switch self {
        case .accessDenied:
            return "미리 알림 전체 접근 권한이 필요합니다. 시스템 설정 > 개인정보 보호 및 보안 > 미리 알림에서 Watchpup을 허용해주세요."
        case .calendarAccessDenied:
            return "캘린더 전체 접근 권한이 필요합니다. 시스템 설정 > 개인정보 보호 및 보안 > 캘린더에서 Watchpup을 허용해주세요."
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
        var arguments = Array(CommandLine.arguments.dropFirst())
        var outputPath: String?
        if let outputIndex = arguments.firstIndex(of: "--output"), arguments.indices.contains(outputIndex + 1) {
            outputPath = arguments[outputIndex + 1]
            arguments.removeSubrange(outputIndex...(outputIndex + 1))
        }
        do {
            let output = try await run(arguments: arguments)
            if let outputPath {
                try writeJSON(["ok": true, "value": output], to: outputPath)
            } else {
                try writeJSON(output)
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            if let outputPath {
                try? writeJSON(["ok": false, "error": message], to: outputPath)
                Foundation.exit(0)
            }
            FileHandle.standardError.write(Data((message + "\n").utf8))
            Foundation.exit(1)
        }
    }

    private static func run(arguments: [String]) async throws -> Any {
        guard let command = arguments.first else {
            throw HelperError.invalidArguments("명령이 없습니다.")
        }
        let store = EKEventStore()
        if command == "authorization-status" {
            guard arguments.count >= 2 else {
                throw HelperError.invalidArguments("authorization-status에는 calendar 또는 reminders가 필요합니다.")
            }
            let entityType: EKEntityType = arguments[1] == "calendar" ? .event : .reminder
            return ["status": authorizationStatus(entityType)]
        }
        if command == "request-calendar-access" {
            guard try await requestCalendarAccess(store) else {
                throw HelperError.calendarAccessDenied
            }
            return ["status": authorizationStatus(.event)]
        }
        if command == "upcoming-events" {
            guard try await requestCalendarAccess(store) else {
                throw HelperError.calendarAccessDenied
            }
        } else {
            guard try await requestReminderAccess(store) else {
                throw HelperError.accessDenied
            }
        }

        switch command {
        case "upcoming-events":
            guard arguments.count >= 3,
                  let startMilliseconds = Double(arguments[1]),
                  let endMilliseconds = Double(arguments[2]) else {
                throw HelperError.invalidArguments("upcoming-events에는 시작·종료 epoch millisecond가 필요합니다.")
            }
            let start = Date(timeIntervalSince1970: startMilliseconds / 1000)
            let end = Date(timeIntervalSince1970: endMilliseconds / 1000)
            let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
            return store.events(matching: predicate)
                .filter { !$0.isAllDay && $0.status != .canceled }
                .map { event in
                    [
                        "id": event.calendarItemIdentifier,
                        "title": event.title ?? "일정",
                        "startAt": dateString(event.startDate),
                        "endAt": dateString(event.endDate),
                        "calendarName": event.calendar.title,
                        "location": event.location as Any? ?? NSNull(),
                    ] as [String: Any]
                }
                .sorted { lhs, rhs in
                    (lhs["startAt"] as? String ?? "") < (rhs["startAt"] as? String ?? "")
                }

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
            let hierarchy = ReminderKitBridge().hierarchy(listIdentifier: calendar.calendarIdentifier)
            return reminders.map { reminder in
                let entry = hierarchy[reminder.calendarItemIdentifier]
                return [
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
                    "parentId": entry?.parentID as Any? ?? NSNull(),
                    "childIds": entry?.childIDs ?? [],
                    "depth": entry?.depth ?? 0,
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

        case "create":
            guard arguments.count >= 3 else {
                throw HelperError.invalidArguments("create에는 목록 ID와 제목이 필요합니다.")
            }
            guard let calendar = store.calendar(withIdentifier: arguments[1]) else {
                throw HelperError.listNotFound
            }
            let title = arguments[2].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else {
                throw HelperError.invalidArguments("작업 제목을 입력해주세요.")
            }
            let reminder = EKReminder(eventStore: store)
            reminder.calendar = calendar
            reminder.title = title
            if arguments.count >= 4 {
                let notes = arguments[3].trimmingCharacters(in: .whitespacesAndNewlines)
                reminder.notes = notes.isEmpty ? nil : notes
            }
            try store.save(reminder, commit: true)
            return ["ok": true, "id": reminder.calendarItemIdentifier]

        case "update-title":
            guard arguments.count >= 3 else {
                throw HelperError.invalidArguments("update-title에는 항목 ID와 제목이 필요합니다.")
            }
            guard let reminder = store.calendarItem(withIdentifier: arguments[1]) as? EKReminder else {
                throw HelperError.reminderNotFound
            }
            let title = arguments[2].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else {
                throw HelperError.invalidArguments("작업 제목을 입력해주세요.")
            }
            reminder.title = title
            try store.save(reminder, commit: true)
            return ["ok": true]

        case "update-user-note":
            guard arguments.count >= 3 else {
                throw HelperError.invalidArguments("update-user-note에는 항목 ID와 메모가 필요합니다.")
            }
            guard let reminder = store.calendarItem(withIdentifier: arguments[1]) as? EKReminder else {
                throw HelperError.reminderNotFound
            }
            reminder.notes = replacingUserNote(in: reminder.notes ?? "", with: arguments[2])
            try store.save(reminder, commit: true)
            return ["ok": true]

        case "add-subtask":
            guard arguments.count >= 3 else {
                throw HelperError.invalidArguments("add-subtask에는 부모 항목 ID와 제목이 필요합니다.")
            }
            let title = arguments[2].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else {
                throw HelperError.invalidArguments("서브태스크 제목을 입력해주세요.")
            }
            let id = try ReminderKitBridge().addSubtask(title: title, parentReminderID: arguments[1])
            return ["ok": true, "id": id]

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

    private static func requestReminderAccess(_ store: EKEventStore) async throws -> Bool {
        try await store.requestFullAccessToReminders()
    }

    private static func requestCalendarAccess(_ store: EKEventStore) async throws -> Bool {
        try await store.requestFullAccessToEvents()
    }

    private static func authorizationStatus(_ entityType: EKEntityType) -> String {
        switch EKEventStore.authorizationStatus(for: entityType) {
        case .notDetermined:
            return "not-determined"
        case .restricted:
            return "restricted"
        case .denied:
            return "denied"
        case .writeOnly:
            return "write-only"
        case .authorized, .fullAccess:
            return "authorized"
        @unknown default:
            return "unknown"
        }
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

    private static func replacingUserNote(in notes: String, with content: String) -> String {
        let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        let expression = try? NSRegularExpression(pattern: #"<note>\s*([\s\S]*?)\s*</note>"#, options: [.caseInsensitive])
        let range = NSRange(trimmedNotes.startIndex..<trimmedNotes.endIndex, in: trimmedNotes)
        let match = expression?.firstMatch(in: trimmedNotes, range: range)
        let block = "<note>\n\(trimmedContent)\n</note>"

        if let match, let blockRange = Range(match.range, in: trimmedNotes) {
            let replacement = trimmedContent.isEmpty ? "" : block
            return normalizedBlankLines(trimmedNotes.replacingCharacters(in: blockRange, with: replacement))
        }
        guard !trimmedContent.isEmpty else { return trimmedNotes }
        return trimmedNotes.isEmpty ? block : "\(trimmedNotes)\n\n\(block)"
    }

    private static func normalizedBlankLines(_ text: String) -> String {
        text.replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func writeJSON(_ value: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    private static func writeJSON(_ value: Any, to path: String) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}
