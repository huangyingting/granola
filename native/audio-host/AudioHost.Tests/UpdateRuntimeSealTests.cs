using System.Text;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.Updates;
using Xunit;

namespace WindowsAiNotes.AudioTests;

public sealed class UpdateRuntimeSealTests
{
    private static UpdateRuntimeSeal Valid => new(1, "0.1.1",
    [
        new("AudioHost.dll", 123, new('a', 64)),
        new("licenses/notice.txt", 0, new('b', 64))
    ]);

    private static byte[] Serialize(UpdateRuntimeSeal seal) => JsonSerializer.SerializeToUtf8Bytes(seal, AudioJson.Options);

    [Fact]
    public void AcceptsOnlyAnOrderedBoundedInventoryWithoutClaimingSignatureOrFreshHealth()
    {
        var parsed = UpdateRuntimeSeal.Parse(Serialize(Valid));
        Assert.Equal(Valid.Version, parsed.Version);
        Assert.Equal(Valid.ApplicationVersion, parsed.ApplicationVersion);
        Assert.Equal(Valid.Files, parsed.Files);
    }

    [Theory]
    [InlineData("")]
    [InlineData("/absolute.dll")]
    [InlineData("../outside.dll")]
    [InlineData("licenses/../outside.dll")]
    [InlineData("licenses//notice.txt")]
    [InlineData("licenses/./notice.txt")]
    [InlineData("licenses\\notice.txt")]
    [InlineData("C:/outside.dll")]
    [InlineData("file.dll:stream")]
    [InlineData("trailing.")]
    [InlineData(" whitespace.dll")]
    [InlineData("whitespace.dll ")]
    [InlineData("CON.dll")]
    [InlineData("licenses/nul")]
    [InlineData("com1.txt")]
    [InlineData("LPT0")]
    [InlineData("invalid?.dll")]
    [InlineData("invalid\u0000.dll")]
    [InlineData("invalid\n.dll")]
    [InlineData("nonascii-\u00e9.dll")]
    [InlineData("AudioHost.exe")]
    [InlineData("audiohost.EXE")]
    [InlineData("update-outcome.json")]
    [InlineData("UPDATE-RUNTIME-STATE.JSON")]
    [InlineData("update-runtime-files.json")]
    public void RejectsAmbiguousPathsSelfReferenceAndMutableMetadata(string path)
    {
        var seal = Valid with { Files = [new(path, 1, new('a', 64))] };
        AssertInvalid(Serialize(seal));
    }

    [Theory]
    [InlineData("01.1.1")]
    [InlineData("0.1.1-preview")]
    [InlineData("0.1.1.0")]
    [InlineData("65536.0.0")]
    [InlineData("0.1.1\n")]
    public void RejectsNoncanonicalApplicationVersions(string version) =>
        AssertInvalid(Serialize(Valid with { ApplicationVersion = version }));

    [Fact]
    public void RejectsOversizeCountsTotalsUnorderedAndAliasedMembers()
    {
        foreach (var seal in new[]
        {
            Valid with { Version = 2 },
            Valid with { Files = [] },
            Valid with { Files = [Valid.Files[1], Valid.Files[0]] },
            Valid with { Files = [Valid.Files[0], Valid.Files[0]] },
            Valid with { Files = [Valid.Files[0], Valid.Files[0] with { Path = "audiohost.DLL" }] },
            Valid with { Files = [Valid.Files[0] with { Path = new('a', 241) }] },
            Valid with { Files = [Valid.Files[0] with { Bytes = -1 }] },
            Valid with { Files = [Valid.Files[0] with { Bytes = UpdateRuntimeSeal.MaximumPayloadBytes + 1 }] },
            Valid with { Files = [Valid.Files[0] with { Bytes = UpdateRuntimeSeal.MaximumPayloadBytes }, Valid.Files[1] with { Bytes = 1 }] },
            Valid with { Files = [Valid.Files[0] with { Sha256 = new('A', 64) }] },
            Valid with { Files = [Valid.Files[0] with { Sha256 = new('a', 63) }] },
            Valid with { Files = Enumerable.Range(0, UpdateRuntimeSeal.MaximumFiles + 1)
                .Select(index => new UpdateRuntimeMember($"file{index:D4}", 1, new('a', 64))).ToArray() }
        })
            AssertInvalid(Serialize(seal));
        AssertInvalid([]);
        AssertInvalid(new byte[UpdateRuntimeSeal.MaximumBytes + 1]);
    }

    [Theory]
    [InlineData("""null""")]
    [InlineData("""[]""")]
    [InlineData("""{}""")]
    [InlineData("""{"version":1,"application_version":"0.1.1","files":null}""")]
    [InlineData("""{"version":1,"application_version":null,"files":[]}""")]
    [InlineData("""{"version":1,"version":1,"application_version":"0.1.1","files":[]}""")]
    [InlineData("""{"version":1,"application_version":"0.1.1","files":[],"verified":true}""")]
    [InlineData("""{"version":1,"application_version":"0.1.1","files":[null]}""")]
    [InlineData("""{"version":1,"application_version":"0.1.1","files":[{"path":null,"bytes":1,"sha256":"HASH"}]}""")]
    [InlineData("""{"version":1,"application_version":"0.1.1","files":[{"path":"file.dll","bytes":1,"sha256":null}]}""")]
    [InlineData("""{"version":1,"application_version":"0.1.1","files":[{"path":"file.dll","bytes":1,"bytes":1,"sha256":"HASH"}]}""")]
    [InlineData("""{"version":1,"application_version":"0.1.1","files":[{"path":"file.dll","bytes":"1","sha256":"HASH"}]}""")]
    [InlineData("""{"version":1,"application_version":"0.1.1","files":[{"path":"file.dll","bytes":1.5,"sha256":"HASH"}]}""")]
    [InlineData("""{"version":1,"application_version":"0.1.1","files":[{"path":"file.dll","sha256":"HASH"}]}""")]
    [InlineData("""{"version":1,"application_version":"0.1.1","files":[{"path":"file.dll","bytes":1,"sha256":"HASH","trusted":true}]}""")]
    [InlineData("""{"version":1,"application_version":"0.1.1","files":[{"path":"file.dll","bytes":1,"sha256":"HASH"}]}{}""")]
    public void RejectsMalformedNullUnknownMissingAndDuplicateClaims(string json) =>
        AssertInvalid(Encoding.UTF8.GetBytes(json.Replace("HASH", new('a', 64), StringComparison.Ordinal)));

    private static void AssertInvalid(byte[] bytes) =>
        Assert.Equal("update_runtime_seal_invalid", Assert.Throws<UpdateHandoffException>(() => UpdateRuntimeSeal.Parse(bytes)).Code);
}
