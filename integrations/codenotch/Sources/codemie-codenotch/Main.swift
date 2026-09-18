import CodemieCodenotchCore
import Foundation

@main
struct CodemieCodenotch {
    static func main() async {
        let environment = CLI.Environment(
            pluginsDir: Registrar.defaultPluginsDir(),
            resourcesDir: resolveResourcesDir(),
            executablePath: Registrar.currentExecutablePath(),
            codemiePath: Registrar.findCodemieBinary(),
            codemieHome: CodemieConfig.codemieHome(),
            http: URLSessionHTTPClient()
        )
        let code = await CLI.run(arguments: Array(CommandLine.arguments.dropFirst()), environment: environment)
        exit(code)
    }

    /// SwiftPM packs target resources into `<package>_<target>.bundle` next to
    /// the executable. `Bundle.module` *fatal-errors* when that bundle is not
    /// there — the exact situation after someone copies the bare binary
    /// elsewhere — so the lookup is done by hand, and a miss degrades to a
    /// path that exists nowhere. `Registrar` then registers without icons
    /// instead of crashing.
    static func resolveResourcesDir(
        fileManager: FileManager = .default,
        executablePath: String = Registrar.currentExecutablePath()
    ) -> URL {
        let bundleName = "codemie-codenotch_codemie-codenotch.bundle"
        let execDir = URL(fileURLWithPath: executablePath).deletingLastPathComponent()
        let resources = execDir
            .appendingPathComponent(bundleName)
            .appendingPathComponent("Contents/Resources")
        if fileManager.fileExists(atPath: resources.path) { return resources }
        return URL(fileURLWithPath: "/nonexistent")
    }
}
