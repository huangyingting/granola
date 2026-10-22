using System.ComponentModel;
using System.Diagnostics;
using System.Reflection.PortableExecutable;
using System.Security;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;

namespace WindowsAiNotes.AudioHost;

public static class UpdateStartupAdmission
{
    public static async Task<int> RunAsync(int pid, string application, string version, Stream output)
    {
        UpdateParentLease? parent = null;
        try
        {
            var identity = UpdateParentLease.Open(pid, application, out parent);
            if (!identity.Matched || parent is null) throw new UpdateHandoffException(identity.Code);
            using var operation = UpdateOperationLock.Open();
            using var admission = UpdateOperationLock.OpenAdmission();
            RequireBundledApplication(application, version);
            using var retained = UpdateRemoteRuntimeLease.Open(parent, admission.Handles);
            await FrameCodec.WriteJsonAsync(output,
                new { Version = 1, Event = "update_startup_admitted", parent.Identity });
            retained.TransferToParent();
            return 0;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException or
            Win32Exception or ArgumentException or BadImageFormatException)
        {
            var code = error switch
            {
                UpdateHandoffException handoff => handoff.Code,
                UpdateRuntimeException runtime => runtime.Code,
                _ => "update_startup_unavailable"
            };
            try { await FrameCodec.WriteJsonAsync(output, new { Version = 1, Event = "update_startup_failed", Code = code }); }
            catch (IOException) { }
            return 2;
        }
        finally { parent?.Dispose(); }
    }

    private static void RequireBundledApplication(string application, string version)
    {
        var metadata = FileVersionInfo.GetVersionInfo(application);
        var product = metadata.ProductName;
        if (!UpdateTrustVerifier.IsStableVersion(version) || product is null || !UpdateInstallationVerifier.ValidProduct(product))
            throw new UpdateHandoffException("update_installation_arguments");
        var directory = Path.GetDirectoryName(application)!;
        if (!UpdatePathLock.SameFile(application, Path.Combine(directory, $"{product}.exe")))
            throw new UpdateHandoffException("update_installation_identity");
        if (!UpdatePathLock.SameDirectory(Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory),
            Path.Combine(directory, "resources", "audio-host")))
            throw new UpdateHandoffException("update_installation_helper");
        if (metadata.ProductVersion != version && metadata.ProductVersion != $"{version}.0")
            throw new UpdateHandoffException("update_installation_identity");
        using var stream = new FileStream(application, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var pe = new PEReader(stream);
        if (pe.PEHeaders.CoffHeader.Machine != Machine.Amd64)
            throw new UpdateHandoffException("update_installation_architecture");
        // Unsigned, unregistered preview packages remain usable, but never gain installer authorization.
        var policyPath = Path.Combine(directory, "resources", "update-policy.json");
        try { _ = File.GetAttributes(policyPath); }
        catch (FileNotFoundException) { return; }
        var installation = UpdateInstallationVerifier.Verify(application, version, product);
        if (!installation.Registered) throw new UpdateHandoffException(installation.Code);
        var policy = UpdateWorkerPolicy.Read(application);
        if (policy.ProductName != product) throw new UpdateHandoffException("update_policy_invalid");
        var trust = UpdateTrustVerifier.Verify(application, policy.Trust(version));
        if (!trust.Verified) throw new UpdateHandoffException(trust.Code);
    }
}
