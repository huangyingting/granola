using System.Buffers.Binary;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using WindowsAiNotes.Audio;
using WindowsAiNotes.AudioHost;
using Xunit;

namespace WindowsAiNotes.AudioWindowsTests;

public sealed class ArchiveProcessTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReadsDpapiProtectedWavRangesAcrossTheRealFramedProcessBoundary(bool recover)
    {
        var root = Path.Combine(Path.GetTempPath(), "windows-ai-notes-archive-process", Guid.NewGuid().ToString("D"));
        try
        {
            var id = Guid.NewGuid();
            var track = new TrackSpec(Guid.NewGuid(), "microphone", "endpoint", "explicit", "synthetic");
            var store = new RecordingStore(root, id, [track], new DpapiKeyProtector());
            var manifestPath = Path.Combine(store.DirectoryPath, "manifest.enc");
            var originalManifest = File.ReadAllBytes(manifestPath);
            var pcm = RandomNumberGenerator.GetBytes(40_000);
            var writer = new PcmChunkWriter(store, track.TrackId);
            writer.BeginEpoch(Guid.NewGuid());
            writer.Append(pcm, 0, 1250);
            writer.Flush();
            if (recover) File.WriteAllBytes(manifestPath, originalManifest);
            else store.Transition("sealed", "capture.stopped", 1250);
            var start = new ProcessStartInfo("dotnet")
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            start.ArgumentList.Add(typeof(DpapiKeyProtector).Assembly.Location);
            start.ArgumentList.Add("--data-dir");
            start.ArgumentList.Add(root);
            using var process = Process.Start(start) ?? throw new InvalidOperationException("AudioHost did not start.");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var stderr = process.StandardError.ReadToEndAsync(deadline.Token);
            try
            {
                var capacity = await Send(new AudioRequest(1, Guid.NewGuid(), "check_storage",
                    StorageQuotaBytes: StorageBudget.GiB));
                Assert.Equal("storage.status", capacity.GetProperty("event_type").GetString());
                Assert.Equal(Directory.GetFiles(root, "*", SearchOption.AllDirectories).Sum(path => new FileInfo(path).Length),
                    capacity.GetProperty("payload").GetProperty("used_bytes").GetInt64());
                Assert.Equal("ready", capacity.GetProperty("payload").GetProperty("state").GetString());
                var manifest = await Send(new AudioRequest(1, Guid.NewGuid(), "get_recording", id, Offset: 0));
                Assert.Equal("recording.manifest", manifest.GetProperty("event_type").GetString());
                Assert.Equal(recover ? "recording" : "sealed", manifest.GetProperty("payload").GetProperty("state").GetString());
                if (recover)
                {
                    for (var retry = 0; retry < 2; retry++)
                    {
                        var recovered = await Send(new AudioRequest(1, Guid.NewGuid(), "recover_recording", id, AcceptIncomplete: true));
                        Assert.Equal("recording.recovered", recovered.GetProperty("event_type").GetString());
                        Assert.Equal("interrupted", recovered.GetProperty("payload").GetProperty("state").GetString());
                        Assert.Equal(0, recovered.GetProperty("payload").GetProperty("recovered_chunks").GetInt32());
                    }
                    manifest = await Send(new AudioRequest(1, Guid.NewGuid(), "get_recording", id, Offset: 0));
                    Assert.Equal("failed", manifest.GetProperty("payload").GetProperty("state").GetString());
                    Assert.Equal(pcm.Length / 2,
                        manifest.GetProperty("payload").GetProperty("tracks")[0].GetProperty("saved_samples").GetInt64());
                }
                var listed = await Send(new AudioRequest(1, Guid.NewGuid(), "list_recording_chunks", id,
                    TrackId: track.TrackId, SequenceStart: 0));
                var upload = listed.GetProperty("payload").GetProperty("chunks")[0];
                var chunkId = upload.GetProperty("chunk").GetProperty("chunk_id").GetGuid();
                var size = upload.GetProperty("size_bytes").GetInt32();
                using var wav = new MemoryStream();
                while (wav.Length < size)
                {
                    var range = await Send(new AudioRequest(1, Guid.NewGuid(), "read_chunk", id,
                        ChunkId: chunkId, Offset: (int)wav.Length, Length: RecordingArchive.MaxRangeBytes));
                    Assert.Equal("recording.chunk_range", range.GetProperty("event_type").GetString());
                    var payload = range.GetProperty("payload");
                    Assert.Equal(wav.Length, payload.GetProperty("offset").GetInt32());
                    wav.Write(Convert.FromBase64String(payload.GetProperty("data_base64").GetString()!));
                    Assert.Equal(wav.Length == size, payload.GetProperty("end_of_chunk").GetBoolean());
                }
                Assert.Equal(PcmChunkWriter.ToWav(pcm), wav.ToArray());
                Assert.Equal(upload.GetProperty("sha256").GetString(), Convert.ToHexStringLower(SHA256.HashData(wav.ToArray())));
                var unuploaded = Path.Combine(root, "unique-unuploaded.partial");
                using (var file = new FileStream(unuploaded, FileMode.CreateNew, FileAccess.Write))
                    file.SetLength(StorageBudget.GiB);
                var blocked = await Send(new AudioRequest(1, Guid.NewGuid(), "check_storage",
                    StorageQuotaBytes: StorageBudget.GiB));
                Assert.Equal("blocked", blocked.GetProperty("payload").GetProperty("state").GetString());
                var attempt = Guid.NewGuid();
                var rejected = await Send(new AudioRequest(1, Guid.NewGuid(), "start_recording", attempt, [track],
                    StorageQuotaBytes: StorageBudget.GiB));
                Assert.Equal("storage_limit", rejected.GetProperty("payload").GetProperty("code").GetString());
                Assert.False(Directory.Exists(Path.Combine(root, attempt.ToString("D"))));
                Assert.Equal(StorageBudget.GiB, new FileInfo(unuploaded).Length);
                var stillReadable = await Send(new AudioRequest(1, Guid.NewGuid(), "get_recording", id, Offset: 0));
                Assert.Equal(recover ? "failed" : "sealed", stillReadable.GetProperty("payload").GetProperty("state").GetString());
                process.StandardInput.Close();
                await process.WaitForExitAsync(deadline.Token);
                Assert.Equal(0, process.ExitCode);
                Assert.Empty(await stderr);
            }
            finally
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    await process.WaitForExitAsync();
                }
            }

            async Task<JsonElement> Send(AudioRequest request)
            {
                request.Validate();
                var bytes = JsonSerializer.SerializeToUtf8Bytes(request, AudioJson.Options);
                var header = new byte[4];
                BinaryPrimitives.WriteInt32LittleEndian(header, bytes.Length);
                await process.StandardInput.BaseStream.WriteAsync(header, deadline.Token);
                await process.StandardInput.BaseStream.WriteAsync(bytes, deadline.Token);
                await process.StandardInput.BaseStream.FlushAsync(deadline.Token);
                while (true)
                {
                    var body = await FrameCodec.ReadAsync(process.StandardOutput.BaseStream, deadline.Token);
                    Assert.NotNull(body);
                    using var message = JsonDocument.Parse(body);
                    if (message.RootElement.GetProperty("request_id").ValueKind == JsonValueKind.Null)
                    {
                        Assert.Equal("storage.status", message.RootElement.GetProperty("event_type").GetString());
                        Assert.Equal(JsonValueKind.Null, message.RootElement.GetProperty("recording_id").ValueKind);
                        continue;
                    }
                    Assert.Equal(request.RequestId, message.RootElement.GetProperty("request_id").GetGuid());
                    if (request.RecordingId is { } expected)
                        Assert.Equal(expected, message.RootElement.GetProperty("recording_id").GetGuid());
                    else Assert.Equal(JsonValueKind.Null, message.RootElement.GetProperty("recording_id").ValueKind);
                    return message.RootElement.Clone();
                }
            }
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
