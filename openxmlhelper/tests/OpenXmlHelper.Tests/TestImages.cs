using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;

namespace ZhiBiao.OpenXmlHelper.Tests;

/// <summary>按需生成合法的小图片，测试不依赖仓库中的二进制文件。</summary>
static class TestImages
{
    /// <summary>生成指定像素尺寸的灰度 PNG。</summary>
    public static byte[] Png(int width, int height)
    {
        using var output = new MemoryStream();
        output.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

        var header = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(0), width);
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), height);
        header[8] = 8; // 位深
        header[9] = 0; // 灰度
        WriteChunk(output, "IHDR", header);

        using (var raw = new MemoryStream())
        {
            using (var zlib = new ZLibStream(raw, CompressionLevel.Fastest, leaveOpen: true))
            {
                var row = new byte[width + 1]; // 每行首字节为过滤类型 0
                for (var y = 0; y < height; y += 1) zlib.Write(row);
            }
            WriteChunk(output, "IDAT", raw.ToArray());
        }

        WriteChunk(output, "IEND", []);
        return output.ToArray();
    }

    /// <summary>只有 SOI、APP0、SOF0 和 EOI 的 JPEG 头部（足以按文件头识别和读取尺寸）。</summary>
    public static byte[] Jpeg(int width, int height)
    {
        byte[] app0 = [0xFF, 0xE0, 0x00, 0x10, (byte)'J', (byte)'F', (byte)'I', (byte)'F', 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
        byte[] sof0 =
        [
            0xFF, 0xC0, 0x00, 0x11, 0x08,
            (byte)(height >> 8), (byte)height, (byte)(width >> 8), (byte)width,
            0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
        ];
        return [0xFF, 0xD8, .. app0, .. sof0, 0xFF, 0xD9];
    }

    public static byte[] Gif(int width, int height)
    {
        var bytes = new byte[13];
        "GIF89a"u8.CopyTo(bytes);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(6), (ushort)width);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(8), (ushort)height);
        return [.. bytes, 0x3B];
    }

    /// <summary>BITMAPINFOHEADER，高度为负（自上而下）以覆盖取绝对值。</summary>
    public static byte[] Bmp(int width, int height)
    {
        var bytes = new byte[54];
        "BM"u8.CopyTo(bytes);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(2), bytes.Length);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(10), 54);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(14), 40);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(18), width);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(22), -height);
        BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(26), 1);
        BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(28), 24);
        return bytes;
    }

    /// <summary>扩展格式（VP8X）的 WebP 头部，画布宽高以减一的 24 位整数存放。</summary>
    public static byte[] Webp(int width, int height)
    {
        var bytes = new byte[30];
        "RIFF"u8.CopyTo(bytes);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), (uint)(bytes.Length - 8));
        "WEBP"u8.CopyTo(bytes.AsSpan(8));
        "VP8X"u8.CopyTo(bytes.AsSpan(12));
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(16), 10);
        WriteUInt24LittleEndian(bytes.AsSpan(24), width - 1);
        WriteUInt24LittleEndian(bytes.AsSpan(27), height - 1);
        return bytes;
    }

    /// <summary>小端 TIFF，首个图像目录只有宽（256）和高（257）两项。</summary>
    public static byte[] Tiff(int width, int height)
    {
        var bytes = new byte[8 + 2 + 2 * 12 + 4];
        "II*\0"u8.CopyTo(bytes);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), 8);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(8), 2);
        WriteTiffShortEntry(bytes.AsSpan(10), 256, width);
        WriteTiffShortEntry(bytes.AsSpan(22), 257, height);
        return bytes;
    }

    /// <summary>EMF 头记录；rclFrame 以 0.01 毫米记录画面尺寸。</summary>
    public static byte[] Emf(int frameWidth, int frameHeight)
    {
        var bytes = new byte[88];
        BinaryPrimitives.WriteUInt32LittleEndian(bytes, 1);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), (uint)bytes.Length);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(32), frameWidth);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(36), frameHeight);
        " EMF"u8.CopyTo(bytes.AsSpan(40));
        return bytes;
    }

    /// <summary>可放置 WMF：22 字节的放置头记录边界框，后接 18 字节的标准头。</summary>
    public static byte[] Wmf(int width, int height)
    {
        var bytes = new byte[22 + 18];
        byte[] key = [0xD7, 0xCD, 0xC6, 0x9A];
        key.CopyTo(bytes, 0);
        BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(10), (short)width);
        BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(12), (short)height);
        BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(14), 1440);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(22), 1);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(24), 9);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(26), 0x0300);
        return bytes;
    }

    static void WriteUInt24LittleEndian(Span<byte> target, int value)
    {
        target[0] = (byte)value;
        target[1] = (byte)(value >> 8);
        target[2] = (byte)(value >> 16);
    }

    static void WriteTiffShortEntry(Span<byte> target, ushort tag, int value)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(target, tag);
        BinaryPrimitives.WriteUInt16LittleEndian(target[2..], 3);
        BinaryPrimitives.WriteUInt32LittleEndian(target[4..], 1);
        BinaryPrimitives.WriteUInt16LittleEndian(target[8..], (ushort)value);
    }

    static void WriteChunk(Stream output, string type, byte[] data)
    {
        var length = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(length, data.Length);
        output.Write(length);
        var typeBytes = Encoding.ASCII.GetBytes(type);
        output.Write(typeBytes);
        output.Write(data);
        var crc = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(crc, Crc32([.. typeBytes, .. data]));
        output.Write(crc);
    }

    static uint Crc32(byte[] bytes)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var value in bytes)
        {
            crc ^= value;
            for (var bit = 0; bit < 8; bit += 1) crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320u : crc >> 1;
        }
        return ~crc;
    }
}
