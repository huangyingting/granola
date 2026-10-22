using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace WindowsAiNotes.AudioHost;

public sealed record UpdateTrustPolicy(string CertificateSha256, string Publisher, string ProductName, string ProductVersion);
public sealed record VerifiedUpdateArtifact(long Bytes, string Sha512, string CertificateSha256, string Publisher, string ProductName, string ProductVersion);
public sealed record UpdateTrustResult(int Version, bool Verified, string Code, VerifiedUpdateArtifact? Artifact)
{
    public static UpdateTrustResult Rejected(string code) => new(1, false, code, null);
}

public static class UpdateTrustVerifier
{
    public const long MaximumArtifactBytes = 2L * 1024 * 1024 * 1024;
    public const string InstallerInternalName = "io.github.windowsainotes.desktop.nsis.x64.v1";

    public static bool HasInstallerIdentity(string? internalName, string? originalFilename, string version) =>
        internalName == InstallerInternalName && originalFilename == $"windows-ai-notes-{version}-x64-setup.exe";

    public static UpdateTrustResult Verify(string file, UpdateTrustPolicy policy) => Verify(file, policy, false);
    public static UpdateTrustResult VerifyInstaller(string file, UpdateTrustPolicy policy) => Verify(file, policy, true);

    private static UpdateTrustResult Verify(string file, UpdateTrustPolicy policy, bool installer)
    {
        if (policy.CertificateSha256.Length != 64 || !policy.CertificateSha256.All(char.IsAsciiHexDigit) ||
            !ValidText(policy.Publisher) || !ValidText(policy.ProductName) || !ValidText(policy.ProductVersion) ||
            file.Length < 4 || !char.IsAsciiLetter(file[0]) || file[1] != ':' || file[2] is not ('\\' or '/') ||
            file.Any(char.IsControl))
            return UpdateTrustResult.Rejected("update_verification_arguments");
        try
        {
            if ((File.GetAttributes(file) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                return UpdateTrustResult.Rejected("update_artifact_invalid");
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (stream.Length is <= 0 or > MaximumArtifactBytes)
                return UpdateTrustResult.Rejected("update_artifact_invalid");
            var fileInfo = new TrustFile
            {
                Size = (uint)Marshal.SizeOf<TrustFile>(),
                Path = file,
                Handle = stream.SafeFileHandle.DangerousGetHandle()
            };
            var pointer = Marshal.AllocHGlobal(Marshal.SizeOf<TrustFile>());
            var data = new TrustData
            {
                Size = (uint)Marshal.SizeOf<TrustData>(),
                UiChoice = 2,
                RevocationChecks = 1,
                UnionChoice = 1,
                File = pointer,
                StateAction = 1,
                // WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | WTD_DISABLE_MD2_MD4 | WTD_MOTW.
                ProviderFlags = 0x80 | 0x2000 | 0x4000
            };
            var action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
            Marshal.StructureToPtr(fileInfo, pointer, false);
            try
            {
                if (WinVerifyTrust(new IntPtr(-1), ref action, ref data) != 0)
                    return UpdateTrustResult.Rejected("update_signature_invalid");
                var provider = WTHelperProvDataFromStateData(data.State);
                var signerPointer = provider == IntPtr.Zero ? IntPtr.Zero :
                    WTHelperGetProvSignerFromChain(provider, 0, false, 0);
                if (signerPointer == IntPtr.Zero)
                    return UpdateTrustResult.Rejected("update_signature_invalid");
                var signer = Marshal.PtrToStructure<ProviderSigner>(signerPointer);
                if (signer.Error != 0 || signer.CertificateCount == 0 || signer.Certificates == IntPtr.Zero ||
                    signer.SignerInfo == IntPtr.Zero)
                    return UpdateTrustResult.Rejected("update_signature_invalid");
                var info = Marshal.PtrToStructure<MessageSigner>(signer.SignerInfo);
                var digest = Marshal.PtrToStringAnsi(info.HashAlgorithm.ObjectId);
                if (digest is not ("2.16.840.1.101.3.4.2.1" or "2.16.840.1.101.3.4.2.2" or "2.16.840.1.101.3.4.2.3"))
                    return UpdateTrustResult.Rejected("update_signature_digest");
                var counterPointer = signer.CounterSignerCount == 0 ? IntPtr.Zero :
                    WTHelperGetProvSignerFromChain(provider, 0, true, 0);
                if (counterPointer == IntPtr.Zero)
                    return UpdateTrustResult.Rejected("update_timestamp_missing");
                var counter = Marshal.PtrToStructure<ProviderSigner>(counterPointer);
                if (counter.Error != 0 || counter.CertificateCount == 0)
                    return UpdateTrustResult.Rejected("update_timestamp_invalid");

                var providerCertificate = Marshal.PtrToStructure<ProviderCertificate>(signer.Certificates);
                if (providerCertificate.Certificate == IntPtr.Zero)
                    return UpdateTrustResult.Rejected("update_signature_invalid");
                var context = Marshal.PtrToStructure<CertificateContext>(providerCertificate.Certificate);
                if (context.Encoded == IntPtr.Zero || context.Bytes is 0 or > 65_536)
                    return UpdateTrustResult.Rejected("update_signature_invalid");
                var encoded = new byte[context.Bytes];
                Marshal.Copy(context.Encoded, encoded, 0, encoded.Length);
                using var certificate = X509CertificateLoader.LoadCertificate(encoded);
                var certificateHash = certificate.GetCertHash(HashAlgorithmName.SHA256);
                var publisher = certificate.GetNameInfo(X509NameType.SimpleName, false);
                var version = FileVersionInfo.GetVersionInfo(file);
                if (!CryptographicOperations.FixedTimeEquals(certificateHash, Convert.FromHexString(policy.CertificateSha256)) ||
                    publisher != policy.Publisher || version.ProductName != policy.ProductName ||
                    !SameVersion(version.ProductVersion, policy.ProductVersion))
                    return UpdateTrustResult.Rejected("update_identity_mismatch");
                if (installer && !HasInstallerIdentity(version.InternalName, version.OriginalFilename, policy.ProductVersion))
                    return UpdateTrustResult.Rejected("update_installer_mismatch");
                stream.Position = 0;
                var hash = Convert.ToBase64String(SHA512.HashData(stream));
                return new UpdateTrustResult(1, true, installer ? "update_installer_verified" : "update_verified",
                    new VerifiedUpdateArtifact(stream.Length, hash, Convert.ToHexStringLower(certificateHash),
                        publisher, version.ProductName!, version.ProductVersion!));
            }
            finally
            {
                data.StateAction = 2;
                WinVerifyTrust(new IntPtr(-1), ref action, ref data);
                Marshal.DestroyStructure<TrustFile>(pointer);
                Marshal.FreeHGlobal(pointer);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or CryptographicException or ArgumentException)
        {
            return UpdateTrustResult.Rejected("update_artifact_unavailable");
        }
    }

    private static bool ValidText(string value) =>
        value.Length is > 0 and <= 200 && value == value.Trim() && !value.Any(char.IsControl);
    private static bool SameVersion(string? actual, string expected) =>
        actual == expected || actual == $"{expected}.0";

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TrustFile
    {
        public uint Size;
        [MarshalAs(UnmanagedType.LPWStr)] public string Path;
        public IntPtr Handle;
        public IntPtr KnownSubject;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TrustData
    {
        public uint Size;
        public IntPtr PolicyCallback;
        public IntPtr SipClient;
        public uint UiChoice;
        public uint RevocationChecks;
        public uint UnionChoice;
        public IntPtr File;
        public uint StateAction;
        public IntPtr State;
        public IntPtr UrlReference;
        public uint ProviderFlags;
        public uint UiContext;
        public IntPtr SignatureSettings;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProviderSigner
    {
        public uint Size;
        public System.Runtime.InteropServices.ComTypes.FILETIME VerifiedAt;
        public uint CertificateCount;
        public IntPtr Certificates;
        public uint SignerType;
        public IntPtr SignerInfo;
        public uint Error;
        public uint CounterSignerCount;
        public IntPtr CounterSigners;
        public IntPtr ChainContext;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProviderCertificate
    {
        public uint Size;
        public IntPtr Certificate;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CertificateContext
    {
        public uint Encoding;
        public IntPtr Encoded;
        public uint Bytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public uint Bytes;
        public IntPtr Data;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AlgorithmIdentifier
    {
        public IntPtr ObjectId;
        public DataBlob Parameters;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MessageSigner
    {
        public uint Version;
        public DataBlob Issuer;
        public DataBlob SerialNumber;
        public AlgorithmIdentifier HashAlgorithm;
    }

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr provider, uint signer,
        [MarshalAs(UnmanagedType.Bool)] bool counterSigner, uint counter);
}
