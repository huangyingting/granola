using System.Security.Cryptography;
using NAudio.Wave;

namespace WindowsAiNotes.Audio;

public sealed class CapturePcmProcessor : IDisposable
{
    private readonly PcmConverter converter;
    private readonly byte[] staging = new byte[PcmConverter.MaxBufferedSeconds * 16_000 * 2];
    private readonly MemoryStream normalized;
    private bool failed;
    private bool disposed;

    public CapturePcmProcessor(WaveFormat format)
    {
        converter = new PcmConverter(format);
        normalized = new MemoryStream(staging, writable: true);
        normalized.SetLength(0);
    }

    // Source bytes are owned; callback memory is borrowed and cleared before return.
    public void Process(byte[] sourceBytes, double startMs, double endMs,
        Action<ReadOnlyMemory<byte>, double, double> consume)
    {
        try
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (failed) throw new InvalidOperationException("A failed capture processor cannot be reused.");
            if (!double.IsFinite(startMs) || !double.IsFinite(endMs) || startMs < 0 || endMs < startMs)
                throw new InvalidDataException("Invalid capture clock range.");
            normalized.SetLength(0);
            converter.Convert(sourceBytes, (bytes, count) => normalized.Write(bytes, 0, count));
            consume(staging.AsMemory(0, checked((int)normalized.Length)), startMs, endMs);
        }
        catch
        {
            failed = true;
            throw;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(sourceBytes);
            CryptographicOperations.ZeroMemory(staging);
            if (!disposed) normalized.SetLength(0);
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        CryptographicOperations.ZeroMemory(staging);
        normalized.Dispose();
    }
}
