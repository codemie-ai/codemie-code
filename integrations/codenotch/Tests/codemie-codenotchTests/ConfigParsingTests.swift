import Foundation
import Testing
@testable import CodemieCodenotchCore

/// A scratch CODEMIE_HOME / plugins dir, removed when the test instance dies.
final class TemporaryHome {
    let url: URL

    init() throws {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent("codemie-codenotch-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: url)
    }
}

struct ConfigParsingTests {
    @Test func parsesFullConfig() throws {
        let json = """
        {
          "activeProfile": "work",
          "profiles": {
            "work": { "baseUrl": "https://api.codemie.example.com", "provider": "codemie-sso" },
            "play": { "baseUrl": "https://other.example.com" }
          },
          "workspace": { "codeMieUrl": "https://codemie.example.com" },
          "userEmail": "you@example.com"
        }
        """
        let config = try #require(CodemieConfig.parse(Data(json.utf8)))
        #expect(config.activeProfile == "work")
        #expect(config.baseUrl == "https://api.codemie.example.com")
        #expect(config.provider == "codemie-sso")
        #expect(config.codeMieUrl == "https://codemie.example.com")
        #expect(config.userEmail == "you@example.com")
        #expect(config.isComplete)
    }

    @Test func missingFieldsYieldNilPaths() throws {
        let config = try #require(CodemieConfig.parse(Data(#"{"activeProfile": "work"}"#.utf8)))
        #expect(config.baseUrl == nil)
        #expect(config.codeMieUrl == nil)
        #expect(config.userEmail == nil)
        #expect(!config.isComplete)
    }

    @Test func unknownActiveProfileHasNoBaseUrl() throws {
        let json = #"{"activeProfile": "ghost", "profiles": {"work": {"baseUrl": "https://x"}}}"#
        let config = try #require(CodemieConfig.parse(Data(json.utf8)))
        #expect(config.baseUrl == nil)
        #expect(config.provider == nil)
    }

    @Test func garbageIsNotAConfig() {
        #expect(CodemieConfig.parse(Data("not json".utf8)) == nil)
        #expect(CodemieConfig.parse(Data("[1,2,3]".utf8)) == nil)
    }

    @Test func loadReadsCodemieCliConfigFromHome() throws {
        let home = try TemporaryHome()
        let json = #"{"userEmail": "a@b.c", "workspace": {"codeMieUrl": "https://m"}, "activeProfile": "p", "profiles": {"p": {"baseUrl": "https://b"}}}"#
        try Data(json.utf8).write(to: home.url.appendingPathComponent("codemie-cli.config.json"))
        let config = try #require(CodemieConfig.load(from: home.url))
        #expect(config.userEmail == "a@b.c")
        #expect(CodemieConfig.load(from: home.url.appendingPathComponent("missing")) == nil)
    }
}
