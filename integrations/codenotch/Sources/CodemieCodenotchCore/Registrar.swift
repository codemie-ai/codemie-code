import Foundation

public enum PluginID: String, Sendable, CaseIterable {
    case budget = "codemie-budget"
    case claude = "codemie-claude"
}

public struct Registrar: Sendable {
    public static let version = "0.1.0"
    public static let signInGuidance = "Run `codemie profile login` in Terminal."

    /// Directory holding the two glyph assets this registrar copies next to
    /// each manifest. The executable passes its `Bundle.module.resourceURL`.
    public var resourcesDir: URL
    public var executablePath: String
    /// Resolved `codemie` CLI path when discoverable; controls `signIn.run`.
    public var codemiePath: String?

    public init(resourcesDir: URL, executablePath: String, codemiePath: String?) {
        self.resourcesDir = resourcesDir
        self.executablePath = executablePath
        self.codemiePath = codemiePath
    }

    public static func defaultPluginsDir(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> URL {
        if let override = environment["CODENOTCH_PLUGINS_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Codenotch/Plugins")
    }

    /// The real absolute path of the running executable, via
    /// `_NSGetExecutablePath`, falling back to argv[0].
    public static func currentExecutablePath(arguments: [String] = CommandLine.arguments) -> String {
        var size: UInt32 = 0
        _NSGetExecutablePath(nil, &size)
        var buffer = [CChar](repeating: 0, count: Int(size))
        let written: Int32 = buffer.withUnsafeMutableBufferPointer { ptr in
            _NSGetExecutablePath(ptr.baseAddress, &size)
        }
        if written == 0, let path = String(utf8String: buffer) {
            return URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        }
        if let bundlePath = Bundle.main.executableURL?.resolvingSymlinksInPath().path {
            return bundlePath
        }
        let argv0 = arguments.first ?? "codemie-codenotch"
        return URL(fileURLWithPath: argv0).resolvingSymlinksInPath().path
    }

    /// A `codemie` executable in the usual install locations: Homebrew (both
    /// prefixes), an npm-global prefix, or the newest nvm node version.
    public static func findCodemieBinary(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        fileManager: FileManager = .default
    ) -> String? {
        var candidates = [
            "/usr/local/bin/codemie",
            "/opt/homebrew/bin/codemie",
            home.appendingPathComponent(".npm-global/bin/codemie").path,
        ]
        let nvmVersions = home.appendingPathComponent(".nvm/versions/node")
        if let entries = try? fileManager.contentsOfDirectory(atPath: nvmVersions.path) {
            let newest = entries
                .filter { $0.hasPrefix("v") }
                .max { compareVersions($0, $1) == .orderedAscending }
            if let newest {
                candidates.append(nvmVersions.appendingPathComponent("\(newest)/bin/codemie").path)
            }
        }
        return candidates.first { fileManager.isExecutableFile(atPath: $0) }
    }

    static func compareVersions(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let l = lhs.drop(while: { !$0.isNumber }).split(separator: ".").compactMap { Int($0) }
        let r = rhs.drop(while: { !$0.isNumber }).split(separator: ".").compactMap { Int($0) }
        for index in 0 ..< max(l.count, r.count) {
            let a = index < l.count ? l[index] : 0
            let b = index < r.count ? r[index] : 0
            if a != b { return a < b ? .orderedAscending : .orderedDescending }
        }
        return .orderedSame
    }

    public func manifest(for plugin: PluginID, includeGlyph: Bool = true) -> [String: Any] {
        var signIn: [String: Any] = ["guidance": Self.signInGuidance]
        if let codemiePath {
            signIn["run"] = [codemiePath, "profile", "login"]
        }
        var manifest: [String: Any] = [
            "schema": 1,
            "id": plugin.rawValue,
            "displayName": plugin == .budget ? "CodeMie Budget" : "CodeMie Claude",
            "version": Self.version,
            "exec": [
                "path": executablePath,
                "args": ["snapshot", "--provider", plugin.rawValue],
                "timeoutSeconds": 20,
            ],
            "signIn": signIn,
        ]
        if includeGlyph {
            manifest["glyph"] = ["image": "glyph.png", "opticalScale": 1.0]
        }
        if plugin == .claude {
            manifest["activity"] = ["type": "claudeSessions", "configDir": "~/.claude"]
        }
        return manifest
    }

    /// Writes both plugin directories. Returns one line per file written for
    /// the caller to print. Idempotent: identical inputs rewrite identical
    /// bytes.
    @discardableResult
    public func register(pluginsDir: URL) throws -> [String] {
        let fileManager = FileManager.default
        var written: [String] = []
        for plugin in PluginID.allCases {
            let dir = pluginsDir.appendingPathComponent(plugin.rawValue)
            try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)

            let glyphSource = resourcesDir.appendingPathComponent("glyph-\(plugin.rawValue).png")
            let hasGlyph = fileManager.fileExists(atPath: glyphSource.path)

            let manifestData = try JSONSerialization.data(
                withJSONObject: manifest(for: plugin, includeGlyph: hasGlyph),
                options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            )
            let manifestURL = dir.appendingPathComponent("plugin.json")
            try manifestData.write(to: manifestURL, options: .atomic)
            written.append(manifestURL.path)

            if hasGlyph {
                let glyphDest = dir.appendingPathComponent("glyph.png")
                if fileManager.fileExists(atPath: glyphDest.path) {
                    try fileManager.removeItem(at: glyphDest)
                }
                try fileManager.copyItem(at: glyphSource, to: glyphDest)
                written.append(glyphDest.path)
            } else {
                // A bare binary copied away from its SwiftPM resource bundle
                // must still register — the app draws a generic mark. Lying in
                // the manifest ("glyph": …) would fail app-side validation
                // and skip the plugin entirely, which is the worse outcome.
                FileHandle.standardError.write(Data(
                    "warning: \(glyphSource.path) not found; registering \(plugin.rawValue) without an icon\n".utf8))
            }
        }
        return written
    }

    /// Removes a plugin directory — only when its manifest carries the
    /// expected id, so a directory the user repurposed is never deleted.
    /// Returns one line per outcome for the caller to print.
    @discardableResult
    public func unregister(pluginsDir: URL) -> [String] {
        let fileManager = FileManager.default
        var lines: [String] = []
        for plugin in PluginID.allCases {
            let dir = pluginsDir.appendingPathComponent(plugin.rawValue)
            let manifestURL = dir.appendingPathComponent("plugin.json")
            guard fileManager.fileExists(atPath: manifestURL.path) else {
                lines.append("\(plugin.rawValue): not registered")
                continue
            }
            guard let data = try? Data(contentsOf: manifestURL),
                  let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  manifest["id"] as? String == plugin.rawValue else {
                lines.append("\(plugin.rawValue): skipped (plugin.json id does not match)")
                continue
            }
            do {
                try fileManager.removeItem(at: dir)
                lines.append("\(plugin.rawValue): removed \(dir.path)")
            } catch {
                lines.append("\(plugin.rawValue): failed to remove — \(error.localizedDescription)")
            }
        }
        return lines
    }
}
