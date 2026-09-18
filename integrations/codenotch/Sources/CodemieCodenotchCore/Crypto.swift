import CryptoKit
import Foundation

enum SHA {
    static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }

    static func sha256Hex(_ string: String) -> String {
        hex(sha256(Data(string.utf8)))
    }

    static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    static func data(fromHex string: String) -> Data? {
        var bytes = [UInt8]()
        bytes.reserveCapacity(string.count / 2)
        var index = string.startIndex
        while index < string.endIndex {
            let next = string.index(index, offsetBy: 2, limitedBy: string.endIndex) ?? string.endIndex
            guard next > index, let byte = UInt8(string[index ..< next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        return Data(bytes)
    }
}
