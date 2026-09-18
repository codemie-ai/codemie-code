import Foundation

public enum CLI {
    public static let usage = """
    Usage: codemie-codenotch <command> [options]

    Commands:
      register   [--plugins-dir <path>]   Install the codemie-budget and codemie-claude plugins
      unregister [--plugins-dir <path>]   Remove both plugins
      snapshot   --provider <id>          Print the usage payload (codemie-budget|codemie-claude)

    stdout carries only protocol output; diagnostics go to stderr.
    """

    public struct Environment: Sendable {
        public var pluginsDir: URL
        public var resourcesDir: URL
        public var executablePath: String
        public var codemiePath: String?
        public var codemieHome: URL
        public var http: HTTPClient

        public init(
            pluginsDir: URL,
            resourcesDir: URL,
            executablePath: String,
            codemiePath: String?,
            codemieHome: URL,
            http: HTTPClient
        ) {
            self.pluginsDir = pluginsDir
            self.resourcesDir = resourcesDir
            self.executablePath = executablePath
            self.codemiePath = codemiePath
            self.codemieHome = codemieHome
            self.http = http
        }
    }

    /// Runs the command and returns the process exit code. Stdout is kept
    /// clean for the wire protocol; everything human-facing goes to stderr,
    /// except the register/unregister reports which are the command's output.
    public static func run(arguments: [String], environment: Environment) async -> Int32 {
        var args = arguments
        guard let command = args.first else {
            FileHandle.standardError.write(Data((usage + "\n").utf8))
            return 2
        }
        args.removeFirst()

        switch command {
        case "register", "unregister":
            var pluginsDir = environment.pluginsDir
            var index = 0
            while index < args.count {
                switch args[index] {
                case "--plugins-dir" where index + 1 < args.count:
                    pluginsDir = URL(fileURLWithPath: (args[index + 1] as NSString).expandingTildeInPath)
                    index += 2
                default:
                    FileHandle.standardError.write(Data("unknown argument: \(args[index])\n\(usage)\n".utf8))
                    return 2
                }
            }
            let registrar = Registrar(
                resourcesDir: environment.resourcesDir,
                executablePath: environment.executablePath,
                codemiePath: environment.codemiePath
            )
            if command == "register" {
                do {
                    let written = try registrar.register(pluginsDir: pluginsDir)
                    for path in written { print("wrote \(path)") }
                    return 0
                } catch {
                    FileHandle.standardError.write(Data("register failed: \(error.localizedDescription)\n".utf8))
                    return 1
                }
            } else {
                for line in registrar.unregister(pluginsDir: pluginsDir) { print(line) }
                return 0
            }

        case "snapshot":
            var provider: Provider?
            var index = 0
            while index < args.count {
                switch args[index] {
                case "--provider" where index + 1 < args.count:
                    provider = Provider(rawValue: args[index + 1])
                    if provider == nil {
                        FileHandle.standardError.write(Data("unknown provider: \(args[index + 1])\n".utf8))
                        return 2
                    }
                    index += 2
                default:
                    FileHandle.standardError.write(Data("unknown argument: \(args[index])\n\(usage)\n".utf8))
                    return 2
                }
            }
            guard let provider else {
                FileHandle.standardError.write(Data("snapshot requires --provider <codemie-budget|codemie-claude>\n".utf8))
                return 2
            }
            let runner = SnapshotRunner(home: environment.codemieHome, http: environment.http)
            let outcome = await runner.run(provider) {
                FileHandle.standardError.write(Data("codemie-codenotch: \($0)\n".utf8))
            }
            if let stdout = outcome.stdout { print(stdout) }
            if let stderr = outcome.stderr {
                FileHandle.standardError.write(Data("codemie-codenotch: \(stderr)\n".utf8))
            }
            return outcome.exitCode

        case "--help", "-h", "help":
            print(usage)
            return 0

        default:
            FileHandle.standardError.write(Data("unknown command: \(command)\n\(usage)\n".utf8))
            return 2
        }
    }
}
