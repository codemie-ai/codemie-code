import Foundation

/// The slice of `$CODEMIE_HOME/codemie-cli.config.json` the plugin reads.
public struct CodemieConfig: Sendable {
    public struct Profile: Sendable {
        public var baseUrl: String?
        public var provider: String?
    }

    public var activeProfile: String?
    public var profiles: [String: Profile]
    public var codeMieUrl: String?
    public var userEmail: String?

    public init(activeProfile: String? = nil, profiles: [String: Profile] = [:], codeMieUrl: String? = nil, userEmail: String? = nil) {
        self.activeProfile = activeProfile
        self.profiles = profiles
        self.codeMieUrl = codeMieUrl
        self.userEmail = userEmail
    }

    /// The base URL of the active profile, if both are present.
    public var baseUrl: String? {
        guard let activeProfile, let profile = profiles[activeProfile] else { return nil }
        return profile.baseUrl
    }

    /// The provider kind of the active profile (e.g. "codemie-sso").
    public var provider: String? {
        guard let activeProfile else { return nil }
        return profiles[activeProfile]?.provider
    }

    /// Everything a snapshot needs; nil when any required field is missing.
    public var isComplete: Bool {
        baseUrl != nil && codeMieUrl != nil && userEmail != nil
    }

    public static func codemieHome(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let home = environment["CODEMIE_HOME"], !home.isEmpty {
            return URL(fileURLWithPath: (home as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codemie")
    }

    public static func load(from home: URL) -> CodemieConfig? {
        let url = home.appendingPathComponent("codemie-cli.config.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return parse(data)
    }

    public static func parse(_ data: Data) -> CodemieConfig? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        var config = CodemieConfig()
        config.activeProfile = root["activeProfile"] as? String
        config.userEmail = root["userEmail"] as? String
        if let workspace = root["workspace"] as? [String: Any] {
            config.codeMieUrl = workspace["codeMieUrl"] as? String
        }
        var profiles: [String: Profile] = [:]
        if let rawProfiles = root["profiles"] as? [String: Any] {
            for (name, value) in rawProfiles {
                guard let dict = value as? [String: Any] else { continue }
                profiles[name] = Profile(
                    baseUrl: dict["baseUrl"] as? String,
                    provider: dict["provider"] as? String
                )
            }
        }
        config.profiles = profiles
        return config
    }
}
