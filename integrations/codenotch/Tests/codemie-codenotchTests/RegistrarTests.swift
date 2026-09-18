import Foundation
import Testing
@testable import CodemieCodenotchCore

final class RegistrarTests {
    let resources: TemporaryHome
    let plugins: TemporaryHome

    init() throws {
        resources = try TemporaryHome()
        plugins = try TemporaryHome()
        for name in ["glyph-codemie-budget.png", "glyph-codemie-claude.png"] {
            try Data("png-\(name)".utf8).write(to: resources.url.appendingPathComponent(name))
        }
    }

    func registrar(codemiePath: String? = "/opt/homebrew/bin/codemie") -> Registrar {
        Registrar(resourcesDir: resources.url, executablePath: "/usr/local/bin/codemie-codenotch", codemiePath: codemiePath)
    }

    private func manifest(_ id: String) throws -> [String: Any] {
        let url = plugins.url.appendingPathComponent("\(id)/plugin.json")
        let data = try Data(contentsOf: url)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func registerWritesBothPluginsWithValidManifests() throws {
        let written = try registrar().register(pluginsDir: plugins.url)
        #expect(written.count == 4)

        let idPattern = try NSRegularExpression(pattern: "^[a-z0-9][a-z0-9-]*$")
        for (id, displayName) in [("codemie-budget", "CodeMie Budget"), ("codemie-claude", "CodeMie Claude")] {
            let manifest = try manifest(id)
            #expect(manifest["schema"] as? Int == 1)
            #expect(manifest["id"] as? String == id)
            #expect(manifest["displayName"] as? String == displayName)
            #expect(manifest["version"] as? String != nil)
            #expect(idPattern.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)) != nil)

            let exec = try #require(manifest["exec"] as? [String: Any])
            let path = try #require(exec["path"] as? String)
            #expect(path.hasPrefix("/"), "exec.path must be absolute")
            #expect(exec["args"] as? [String] == ["snapshot", "--provider", id])

            let glyph = try #require(manifest["glyph"] as? [String: Any])
            #expect(glyph["image"] as? String == "glyph.png")
            #expect(glyph["opticalScale"] as? Double == 1.0)
            #expect(FileManager.default.fileExists(
                atPath: plugins.url.appendingPathComponent("\(id)/glyph.png").path
            ))

            let signIn = try #require(manifest["signIn"] as? [String: Any])
            #expect(signIn["guidance"] as? String == "Run `codemie profile login` in Terminal.")
            #expect(signIn["run"] as? [String] == ["/opt/homebrew/bin/codemie", "profile", "login"])
        }

        let budget = try manifest("codemie-budget")
        #expect(budget["activity"] == nil, "budget plugin must not declare activity")
        let claude = try manifest("codemie-claude")
        #expect(claude["activity"] as? [String: String] == ["type": "claudeSessions", "configDir": "~/.claude"])
    }

    @Test func signInRunOmittedWhenCodemieNotFound() throws {
        try registrar(codemiePath: nil).register(pluginsDir: plugins.url)
        let signIn = try #require(manifest("codemie-budget")["signIn"] as? [String: Any])
        #expect(signIn["run"] == nil)
        #expect(signIn["guidance"] != nil)
    }

    @Test func registerIsIdempotent() throws {
        let registrar = registrar()
        _ = try registrar.register(pluginsDir: plugins.url)
        let first = try (0 ..< 2).map { index in
            try Data(contentsOf: plugins.url.appendingPathComponent(
                index == 0 ? "codemie-budget/plugin.json" : "codemie-claude/plugin.json"
            ))
        }
        _ = try registrar.register(pluginsDir: plugins.url)
        let second = try (0 ..< 2).map { index in
            try Data(contentsOf: plugins.url.appendingPathComponent(
                index == 0 ? "codemie-budget/plugin.json" : "codemie-claude/plugin.json"
            ))
        }
        #expect(first == second)
    }

    @Test func registerCreatesIntermediates() throws {
        let nested = plugins.url.appendingPathComponent("a/b/c")
        _ = try registrar().register(pluginsDir: nested)
        #expect(FileManager.default.fileExists(atPath: nested.appendingPathComponent("codemie-budget/plugin.json").path))
    }

    @Test func unregisterRemovesOnlyMatchingPlugins() throws {
        try registrar().register(pluginsDir: plugins.url)
        // A lookalike directory with a foreign id must survive.
        let foreign = plugins.url.appendingPathComponent("codemie-budget")
        let foreignManifest = foreign.appendingPathComponent("plugin.json")
        try Data(#"{"schema": 1, "id": "someone-else"}"#.utf8).write(to: foreignManifest)

        let lines = registrar().unregister(pluginsDir: plugins.url)
        #expect(lines.count == 2)
        #expect(lines[0].contains("skipped"), "\(lines.joined(separator: "\n"))")
        #expect(FileManager.default.fileExists(atPath: foreign.path))

        // Claude's manifest is genuine and gets removed.
        #expect(!FileManager.default.fileExists(
            atPath: plugins.url.appendingPathComponent("codemie-claude").path
        ))

        // Second unregister: claude reports missing.
        let again = registrar().unregister(pluginsDir: plugins.url)
        #expect(again[1].contains("not registered"))
    }

    @Test func currentExecutablePathIsAbsolute() {
        let path = Registrar.currentExecutablePath()
        #expect(path.hasPrefix("/"))
        #expect(!path.contains(".."))
    }

    @Test func versionComparisonPrefersNewestNode() {
        #expect(Registrar.compareVersions("v22.1.0", "v9.11.2") == .orderedDescending)
        #expect(Registrar.compareVersions("v18.0.0", "v18.0.1") == .orderedAscending)
        #expect(Registrar.compareVersions("v20.1", "v20.1.0") == .orderedSame)
    }
}
