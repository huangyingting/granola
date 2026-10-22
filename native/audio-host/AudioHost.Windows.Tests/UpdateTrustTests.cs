using System.Buffers.Binary;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.AudioHost;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class UpdateTrustTests
{
    private static string Reference => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PowerShell", "7", "pwsh.exe");

    private static UpdateTrustPolicy ReferencePolicy()
    {
#pragma warning disable SYSLIB0057 // X509CertificateLoader cannot extract the independent reference signer from a PE file.
        using var certificate = X509Certificate.CreateFromSignedFile(Reference);
#pragma warning restore SYSLIB0057
        var metadata = FileVersionInfo.GetVersionInfo(Reference);
        return new UpdateTrustPolicy(Convert.ToHexStringLower(SHA256.HashData(certificate.GetRawCertData())),
            "Microsoft Corporation", metadata.ProductName!, metadata.ProductVersion!);
    }

    [Fact]
    public void AcceptsAnActualTrustedTimestampedSha256ExecutableWithTheExactPinnedIdentity()
    {
        var policy = ReferencePolicy();
        var result = UpdateTrustVerifier.Verify(Reference, policy);
        Assert.True(result.Verified, result.Code);
        Assert.Equal("update_verified", result.Code);
        Assert.NotNull(result.Artifact);
        Assert.Equal(policy.CertificateSha256, result.Artifact.CertificateSha256);
        Assert.Equal(policy.Publisher, result.Artifact.Publisher);
        Assert.Equal(policy.ProductName, result.Artifact.ProductName);
        Assert.Equal(policy.ProductVersion, result.Artifact.ProductVersion);
        Assert.Equal(new FileInfo(Reference).Length, result.Artifact.Bytes);
        Assert.Equal(Convert.ToBase64String(SHA512.HashData(File.ReadAllBytes(Reference))), result.Artifact.Sha512);
    }

    [Theory]
    [InlineData("certificate")]
    [InlineData("publisher")]
    [InlineData("product")]
    [InlineData("version")]
    public void RejectsAValidExecutableWithADifferentPinnedIdentity(string field)
    {
        var policy = ReferencePolicy();
        policy = field switch
        {
            "certificate" => policy with { CertificateSha256 = new string('0', 64) },
            "publisher" => policy with { Publisher = "Synthetic wrong publisher" },
            "product" => policy with { ProductName = "Synthetic wrong product" },
            _ => policy with { ProductVersion = "0.0.0" }
        };
        var result = UpdateTrustVerifier.Verify(Reference, policy);
        Assert.False(result.Verified);
        Assert.Equal("update_identity_mismatch", result.Code);
        Assert.Null(result.Artifact);
    }

    [Fact]
    public void RejectsAnUnsignedFirstPartyPeWithoutInstallingATestCertificate()
    {
        var result = UpdateTrustVerifier.Verify(typeof(UpdateTrustTests).Assembly.Location, ReferencePolicy());
        Assert.False(result.Verified);
        Assert.Equal("update_signature_invalid", result.Code);
        Assert.Null(result.Artifact);
    }

    [Fact]
    public void RejectsAModifiedSignedCodeSectionAndDoesNotModifyTheInput()
    {
        var root = Path.Combine(Path.GetTempPath(), $"notes-update-trust-{Guid.NewGuid():D}");
        Directory.CreateDirectory(root);
        try
        {
            var file = Path.Combine(root, "tampered signed.exe");
            File.Copy(Reference, file);
            var bytes = File.ReadAllBytes(file);
            var pe = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(0x3c));
            Assert.Equal("PE\0\0"u8.ToArray(), bytes.AsSpan(pe, 4).ToArray());
            var section = pe + 24 + BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(pe + 20));
            var offset = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(section + 20));
            Assert.True(BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(section + 16)) > 0);
            bytes[offset] ^= 1;
            File.WriteAllBytes(file, bytes);
            var result = UpdateTrustVerifier.Verify(file, ReferencePolicy());
            Assert.False(result.Verified);
            Assert.Equal("update_signature_invalid", result.Code);
            Assert.Null(result.Artifact);
            Assert.Equal(bytes, File.ReadAllBytes(file));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("relative.exe")]
    [InlineData("\\\\server\\share\\installer.exe")]
    [InlineData("C:\\synthetic.exe\n")]
    public void RejectsNonlocalOrControlContainingArguments(string file)
    {
        var result = UpdateTrustVerifier.Verify(file, ReferencePolicy());
        Assert.Equal("update_verification_arguments", result.Code);
        Assert.False(result.Verified);
    }

    [Fact]
    public async Task RealOneShotProcessIsBoundedStructuredAndRejectsWrongPins()
    {
        var policy = ReferencePolicy();
        foreach (var valid in new[] { true, false })
        {
            var start = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            foreach (var argument in new[] { typeof(DpapiKeyProtector).Assembly.Location, "--verify-update", Reference,
                valid ? policy.CertificateSha256 : new string('0', 64), policy.Publisher, policy.ProductName, policy.ProductVersion })
                start.ArgumentList.Add(argument);
            using var process = Process.Start(start) ?? throw new InvalidOperationException("The update verifier did not start.");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            var output = process.StandardOutput.ReadToEndAsync(deadline.Token);
            var errors = process.StandardError.ReadToEndAsync(deadline.Token);
            try
            {
                await process.WaitForExitAsync(deadline.Token);
                Assert.Equal(valid ? 0 : 2, process.ExitCode);
                var text = await output;
                Assert.True(text.Length < 4096);
                var report = JsonSerializer.Deserialize<UpdateTrustResult>(text, AudioJson.Options);
                Assert.NotNull(report);
                Assert.Equal(1, report.Version);
                Assert.Equal(valid, report.Verified);
                Assert.Equal(valid ? "update_verified" : "update_identity_mismatch", report.Code);
                Assert.Empty(await errors);
            }
            finally
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    await process.WaitForExitAsync();
                }
            }
        }
    }
}
