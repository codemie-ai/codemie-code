import CommonCrypto
import CryptoKit
import Foundation

public enum CredentialError: Error, Equatable {
    case notFound
    case undecryptable
    case malformed
}

/// The credential the CodeMie CLI stores under `$CODEMIE_HOME/credentials/`,
/// plus the HTTP authentication it maps to.
public enum AuthCredential: Equatable, Sendable {
    case cookies([String: String])
    case bearerToken(String)

    /// Header field name + value for the budget request.
    public var header: (name: String, value: String) {
        switch self {
        case let .cookies(cookies):
            let value = cookies.keys.sorted().map { "\($0)=\(cookies[$0] ?? "")" }.joined(separator: "; ")
            return ("cookie", value)
        case let .bearerToken(token):
            return ("authorization", "Bearer \(token)")
        }
    }
}

public struct CredentialStore: Sendable {
    /// Node's `os.arch()` spelling — Node reports Intel as "x64", not "x86_64".
    public static var nodeArch: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x64"
        #endif
    }

    /// Node's `os.hostname()` is `gethostname(3)`: the bare host name, exactly
    /// as `hostname`(1) prints it. `ProcessInfo.hostName` answers the Bonjour
    /// name instead ("macbook.local"), which derives a *different* AES
    /// key than the one the CLI encrypted with — the GCM tag then fails and
    /// the credential looks "unreadable" when it is merely keyed elsewhere.
    public static func nodeHostName() -> String {
        var buffer = [CChar](repeating: 0, count: 1024)
        guard gethostname(&buffer, buffer.count) == 0 else {
            return ProcessInfo.processInfo.hostName
        }
        return String(cString: buffer)
    }

    /// sha256(hexString(sha256(hostName + platform + arch))) as raw bytes —
    /// the AES key the CodeMie CLI derives from the machine identity.
    public static func deriveKey(
        hostName: String = nodeHostName(),
        platform: String = "darwin",
        arch: String = nodeArch
    ) -> Data {
        let innerHex = SHA.sha256Hex(hostName + platform + arch)
        return SHA.sha256(Data(innerHex.utf8))
    }

    /// The CLI's current storage key: sha256 of the URL reduced to
    /// `protocol//host`, lowercased (`normalizeForKey` in the CLI's
    /// `utils/security.js`). Non-URLs pass through with one trailing slash
    /// stripped.
    public static func credentialHash(codeMieUrl: String) -> String {
        SHA.sha256Hex(normalizeForKey(codeMieUrl))
    }

    /// The pre-normalization storage key: sha256 of the URL with one trailing
    /// slash stripped, lowercased. Credentials written by an older CLI still
    /// sit under this name (`getLegacyUrlStorageKey`).
    public static func legacyCredentialHash(codeMieUrl: String) -> String {
        var raw = codeMieUrl
        if raw.hasSuffix("/") { raw.removeLast() }
        return SHA.sha256Hex(raw.lowercased())
    }

    private static func normalizeForKey(_ baseUrl: String) -> String {
        if let components = URLComponents(string: baseUrl),
           let host = components.host,
           let scheme = components.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            return "\(scheme)://\(host)".lowercased()
        }
        var raw = baseUrl
        if raw.hasSuffix("/") { raw.removeLast() }
        return raw.lowercased()
    }

    /// Loads the first decryptable credential, trying `sso-` (cookies) before
    /// `jwt-sso-` (bearer token), the same order as the CodeMie statusline.
    public static func load(home: URL, codeMieUrl: String, key: Data = deriveKey()) throws -> AuthCredential {
        let hash = credentialHash(codeMieUrl: codeMieUrl)
        let legacyHash = legacyCredentialHash(codeMieUrl: codeMieUrl)
        let credentials = home.appendingPathComponent("credentials")
        // Current scheme first, the pre-normalization name as fallback;
        // `sso-` (cookies) before `jwt-sso-` (bearer), the statusline's order.
        var candidates: [(String, (Data) throws -> AuthCredential)] = [
            ("sso-\(hash).enc", decodeCookies),
            ("jwt-sso-\(hash).enc", decodeToken),
        ]
        if legacyHash != hash {
            candidates.append(("sso-\(legacyHash).enc", decodeCookies))
            candidates.append(("jwt-sso-\(legacyHash).enc", decodeToken))
        }
        var sawFile = false
        for (name, decode) in candidates {
            let url = credentials.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url) else { continue }
            sawFile = true
            if let plaintext = try? decrypt(data, key: key),
               let credential = try? decode(plaintext) {
                return credential
            }
        }
        throw sawFile ? CredentialError.undecryptable : CredentialError.notFound
    }

    /// Decrypts `ivHex:authTagHex:ciphertextHex` (AES-256-GCM) or the legacy
    /// `ivHex:ciphertextHex` (AES-256-CBC with PKCS#7 padding).
    public static func decrypt(_ data: Data, key: Data) throws -> Data {
        let text = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = text.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        switch parts.count {
        case 3:
            guard let iv = SHA.data(fromHex: parts[0]),
                  let tag = SHA.data(fromHex: parts[1]),
                  let ciphertext = SHA.data(fromHex: parts[2]) else { throw CredentialError.malformed }
            let box = try AES.GCM.SealedBox(
                nonce: try AES.GCM.Nonce(data: iv),
                ciphertext: ciphertext,
                tag: tag
            )
            return try AES.GCM.open(box, using: SymmetricKey(data: key))
        case 2:
            guard let iv = SHA.data(fromHex: parts[0]),
                  let ciphertext = SHA.data(fromHex: parts[1]) else { throw CredentialError.malformed }
            return try aesCBCDecrypt(ciphertext, key: key, iv: iv)
        default:
            throw CredentialError.malformed
        }
    }

    static func decodeCookies(_ plaintext: Data) throws -> AuthCredential {
        guard let root = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
              let rawCookies = root["cookies"] as? [String: Any], !rawCookies.isEmpty else {
            throw CredentialError.malformed
        }
        var cookies: [String: String] = [:]
        for (name, value) in rawCookies {
            if let string = value as? String { cookies[name] = string }
        }
        guard !cookies.isEmpty else { throw CredentialError.malformed }
        return .cookies(cookies)
    }

    static func decodeToken(_ plaintext: Data) throws -> AuthCredential {
        guard let root = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
              let token = root["token"] as? String, !token.isEmpty else {
            throw CredentialError.malformed
        }
        return .bearerToken(token)
    }

    private static func aesCBCDecrypt(_ ciphertext: Data, key: Data, iv: Data) throws -> Data {
        var output = [UInt8](repeating: 0, count: ciphertext.count + kCCBlockSizeAES128)
        var outputLength = 0
        let status = output.withUnsafeMutableBytes { outputPtr in
            ciphertext.withUnsafeBytes { ciphertextPtr in
                key.withUnsafeBytes { keyPtr in
                    iv.withUnsafeBytes { ivPtr in
                        CCCrypt(
                            CCOperation(kCCDecrypt),
                            CCAlgorithm(kCCAlgorithmAES),
                            CCOptions(kCCOptionPKCS7Padding),
                            keyPtr.baseAddress, key.count,
                            ivPtr.baseAddress,
                            ciphertextPtr.baseAddress, ciphertext.count,
                            outputPtr.baseAddress, outputPtr.count,
                            &outputLength
                        )
                    }
                }
            }
        }
        guard status == kCCSuccess else { throw CredentialError.undecryptable }
        return Data(output.prefix(outputLength))
    }
}
