import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var url = SharedStore.baseURL ?? SharedStore.defaultBaseURL
    @State private var token = SharedStore.token ?? ""
    @State private var testing = false
    @State private var testResult: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Server URL", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Save") {
                        model.pair(url: url, token: token)
                        testResult = nil
                    }
                    .disabled(url.isEmpty || token.isEmpty)
                    Button {
                        Task { await test() }
                    } label: {
                        HStack { Text("Test connection"); if testing { Spacer(); ProgressView() } }
                    }
                    .disabled(!model.paired || testing)
                    if let testResult { Text(testResult).font(.footnote).foregroundStyle(.secondary) }
                    if model.paired {
                        Button("Unpair", role: .destructive) { model.unpair(); token = "" }
                    }
                } header: { Text("Server") } footer: {
                    Text("Opening a mailcoach://pair link fills this in.")
                }

                Section("Status") {
                    if let s = model.summary?.lastSync, let d = Dates.parse(s) {
                        LabeledContent("Mailbox checked", value: Dates.relative(d))
                    } else {
                        LabeledContent("Mailbox checked", value: "—")
                    }
                    LabeledContent("Needs you", value: "\(model.openCount)")
                    LabeledContent("Widget storage", value: SharedStore.resolvedGroup == nil ? "not shared" : "shared")
                    if let g = SharedStore.resolvedGroup {
                        Text(g).font(.caption2.monospaced()).foregroundStyle(.secondary)
                    }
                }

                UpdateSection()
            }
            .navigationTitle("Settings")
            .onAppear {
                url = SharedStore.baseURL ?? SharedStore.defaultBaseURL
                token = SharedStore.token ?? ""
            }
        }
    }

    private func test() async {
        guard let api = API.current else { testResult = APIError.notPaired.localizedDescription; return }
        testing = true
        defer { testing = false }
        do {
            let w = try await api.widget()
            testResult = "Connected · \(w.open) need you"
            await model.load()
        } catch {
            testResult = error.localizedDescription
        }
    }
}
