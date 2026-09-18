import CommonCrypto
import CryptoKit
import Foundation
import Testing
@testable import CodemieCodenotchCore

struct CredentialCryptoTests {
    // Fixed identity so the test doesn't depend on the host machine's name.
    let key = CredentialStore.deriveKey(hostName: "Unit-Test-Mac.local", platform: "darwin", arch: "arm64")
    let wrongKey = CredentialStore.deriveKey(hostName: "other-host", platform: "darwin", arch: "arm64")

    @Test func keyDerivationMatchesSpec() {
        // inner = sha256("host" + "darwin" + "arm64"), key = sha256(hex(inner))
        let inner = SHA256.hash(data: Data("hostdarwinarm64".utf8))
        let hex = inner.map { String(format: "%02x", $0) }.joined()
        let expected = Data(SHA256.hash(data: Data(hex.utf8)))
        #expect(CredentialStore.deriveKey(hostName: "host", platform: "darwin", arch: "arm64") == expected)
        #expect(expected.count == 32)
    }

    @Test func credentialHashNormalizesUrl() {
        let a = CredentialStore.credentialHash(codeMieUrl: "https://CodeMie.example.com/")
        let b = CredentialStore.credentialHash(codeMieUrl: "https://codemie.example.com")
        #expect(a == b)
        #expect(a.count == 64)
        #expect(UInt64(a.prefix(16), radix: 16) != nil)
    }

    @Test func gcmRoundTrip() throws {
        let plaintext = Data(#"{"cookies": {"session": "abc", "csrf": "tok"}}"#.utf8)
        let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key))
        let encoded = [SHA.hex(Data(sealed.nonce)), SHA.hex(sealed.tag), SHA.hex(sealed.ciphertext)]
            .joined(separator: ":")
        let decrypted = try CredentialStore.decrypt(Data(encoded.utf8), key: key)
        #expect(decrypted == plaintext)
    }

    @Test func cbcRoundTrip() throws {
        let plaintext = Data(#"{"token": "jwt-123"}"#.utf8)
        let iv = Data((0 ..< 16).map { UInt8($0) })
        let ciphertext = try aesCBCEncrypt(plaintext, key: key, iv: iv)
        let encoded = "\(SHA.hex(iv)):\(SHA.hex(ciphertext))"
        let decrypted = try CredentialStore.decrypt(Data(encoded.utf8), key: key)
        #expect(decrypted == plaintext)
    }

    @Test func wrongKeyFails() throws {
        let plaintext = Data(#"{"token": "jwt-123"}"#.utf8)
        let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key))
        let encoded = [SHA.hex(Data(sealed.nonce)), SHA.hex(sealed.tag), SHA.hex(sealed.ciphertext)]
            .joined(separator: ":")
        #expect(throws: (any Error).self) {
            try CredentialStore.decrypt(Data(encoded.utf8), key: wrongKey)
        }

        // A wrong CBC key either errors or yields non-plaintext garbage.
        let iv = Data(repeating: 7, count: 16)
        let ciphertext = try aesCBCEncrypt(plaintext, key: key, iv: iv)
        if let decrypted = try? CredentialStore.decrypt(Data("\(SHA.hex(iv)):\(SHA.hex(ciphertext))".utf8), key: wrongKey) {
            #expect(decrypted != plaintext)
        }
    }

    @Test func cookieHeaderFromSSO() throws {
        let home = try TemporaryHome()
        let codeMieUrl = "https://codemie.example.com"
        try writeCredential(home: home.url, codeMieUrl: codeMieUrl, stem: "sso",
                            plaintext: Data(#"{"cookies": {"b": "2", "a": "1"}}"#.utf8))
        let credential = try CredentialStore.load(home: home.url, codeMieUrl: codeMieUrl, key: key)
        #expect(credential == .cookies(["a": "1", "b": "2"]))
        #expect(credential.header.name == "cookie")
        #expect(credential.header.value == "a=1; b=2")
    }

    @Test func bearerHeaderFromJWTAndSSOTakesPrecedence() throws {
        let home = try TemporaryHome()
        let codeMieUrl = "https://codemie.example.com"

        try writeCredential(home: home.url, codeMieUrl: codeMieUrl, stem: "jwt-sso",
                            plaintext: Data(#"{"token": "jwt-123"}"#.utf8))
        var credential = try CredentialStore.load(home: home.url, codeMieUrl: codeMieUrl, key: key)
        #expect(credential == .bearerToken("jwt-123"))
        #expect(credential.header.name == "authorization")
        #expect(credential.header.value == "Bearer jwt-123")

        // sso is tried before jwt-sso, matching the CodeMie statusline.
        try writeCredential(home: home.url, codeMieUrl: codeMieUrl, stem: "sso",
                            plaintext: Data(#"{"cookies": {"s": "x"}}"#.utf8))
        credential = try CredentialStore.load(home: home.url, codeMieUrl: codeMieUrl, key: key)
        #expect(credential == .cookies(["s": "x"]))
    }

    @Test func undecryptableFallsThroughToNextCandidate() throws {
        let home = try TemporaryHome()
        let codeMieUrl = "https://codemie.example.com"
        let hash = CredentialStore.credentialHash(codeMieUrl: codeMieUrl)
        let credentials = home.url.appendingPathComponent("credentials")
        try FileManager.default.createDirectory(at: credentials, withIntermediateDirectories: true)
        // Corrupt sso file, valid jwt-sso file.
        try Data("deadbeef:nothex:ff".utf8).write(to: credentials.appendingPathComponent("sso-\(hash).enc"))
        try writeCredential(home: home.url, codeMieUrl: codeMieUrl, stem: "jwt-sso",
                            plaintext: Data(#"{"token": "tok"}"#.utf8))
        let credential = try CredentialStore.load(home: home.url, codeMieUrl: codeMieUrl, key: key)
        #expect(credential == .bearerToken("tok"))
    }

    @Test func missingCredentialsThrowNotFound() throws {
        let home = try TemporaryHome()
        #expect {
            try CredentialStore.load(home: home.url, codeMieUrl: "https://m", key: key)
        } throws: { error in
            error as? CredentialError == .notFound
        }
    }

    // MARK: helpers

    private func writeCredential(home: URL, codeMieUrl: String, stem: String, plaintext: Data) throws {
        let hash = CredentialStore.credentialHash(codeMieUrl: codeMieUrl)
        let credentials = home.appendingPathComponent("credentials")
        try FileManager.default.createDirectory(at: credentials, withIntermediateDirectories: true)
        let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key))
        let encoded = [SHA.hex(Data(sealed.nonce)), SHA.hex(sealed.tag), SHA.hex(sealed.ciphertext)]
            .joined(separator: ":")
        try Data(encoded.utf8).write(to: credentials.appendingPathComponent("\(stem)-\(hash).enc"))
    }

    private func aesCBCEncrypt(_ plaintext: Data, key: Data, iv: Data) throws -> Data {
        var output = [UInt8](repeating: 0, count: plaintext.count + kCCBlockSizeAES128)
        var outputLength = 0
        let status = output.withUnsafeMutableBytes { outputPtr in
            plaintext.withUnsafeBytes { plaintextPtr in
                key.withUnsafeBytes { keyPtr in
                    iv.withUnsafeBytes { ivPtr in
                        CCCrypt(
                            CCOperation(kCCEncrypt),
                            CCAlgorithm(kCCAlgorithmAES),
                            CCOptions(kCCOptionPKCS7Padding),
                            keyPtr.baseAddress, key.count,
                            ivPtr.baseAddress,
                            plaintextPtr.baseAddress, plaintext.count,
                            outputPtr.baseAddress, outputPtr.count,
                            &outputLength
                        )
                    }
                }
            }
        }
        guard status == kCCSuccess else {
            throw NSError(domain: "test", code: Int(status))
        }
        return Data(output.prefix(outputLength))
    }
}
