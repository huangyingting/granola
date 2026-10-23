using System.Security.AccessControl;
using System.Security.Principal;

namespace WindowsAiNotes.AudioHost;

internal static class UpdatePrivateDirectory
{
    internal static DirectorySecurity Security()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var owner = identity.User ?? throw new UnauthorizedAccessException("No current-user identity is available.");
        var security = new DirectorySecurity();
        security.SetOwner(owner);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in new[] { owner, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Allow));
        return security;
    }

    internal static void Require(string path, bool requireProtected = true)
    {
        UpdateInstallationVerifier.RequireRegularPath(path, directory: true);
        using var identity = WindowsIdentity.GetCurrent();
        var owner = identity.User ?? throw new UnauthorizedAccessException("No current-user identity is available.");
        var security = new DirectoryInfo(path).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner);
        var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToArray();
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        if ((requireProtected && !security.AreAccessRulesProtected) || !owner.Equals(security.GetOwner(typeof(SecurityIdentifier))) ||
            rules.Length != 2 || !rules.Any(rule => rule.IdentityReference.Equals(owner)) ||
            !rules.Any(rule => rule.IdentityReference.Equals(system)) ||
            rules.Any(rule => rule.AccessControlType != AccessControlType.Allow ||
                rule.FileSystemRights != FileSystemRights.FullControl ||
                rule.InheritanceFlags != (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit) ||
                rule.PropagationFlags != PropagationFlags.None))
            throw new UnauthorizedAccessException("The update directory is not private to the current user and SYSTEM.");
    }

    internal static FileSecurity LockSecurity()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var owner = identity.User ?? throw new UnauthorizedAccessException("No current-user identity is available.");
        var security = new FileSecurity();
        security.SetOwner(owner);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in new[] { owner, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
        return security;
    }

    internal static void RequireFile(FileStream file)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var owner = identity.User ?? throw new UnauthorizedAccessException("No current-user identity is available.");
        var security = file.GetAccessControl();
        var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToArray();
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        if (!owner.Equals(security.GetOwner(typeof(SecurityIdentifier))) ||
            rules.Length != 2 || !rules.Any(rule => rule.IdentityReference.Equals(owner)) ||
            !rules.Any(rule => rule.IdentityReference.Equals(system)) ||
            rules.Any(rule => rule.AccessControlType != AccessControlType.Allow ||
                rule.FileSystemRights != FileSystemRights.FullControl ||
                rule.InheritanceFlags != InheritanceFlags.None || rule.PropagationFlags != PropagationFlags.None))
            throw new UnauthorizedAccessException("The update lock is not private to the current user and SYSTEM.");
    }
}
