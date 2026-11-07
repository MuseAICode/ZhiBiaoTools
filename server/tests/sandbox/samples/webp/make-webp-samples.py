# 生成 WebP 转 PNG 的测试样本（路线图 7.4i；tests/sandbox/webp.test.ts、tests/sandbox/docker/exportDocument.test.ts）。
# 用法（需要带 WebP 支持的 Pillow）：python3 make-webp-samples.py <输出目录>
# 每张图的左半为不透明的纯色、右半全透明（opaque-lossy 除外），测试按位置核对颜色与透明度。
import sys

from PIL import Image

out = sys.argv[1]
W, H = 64, 48


def half(color):
    image = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    for x in range(W // 2):
        for y in range(H):
            image.putpixel((x, y), color)
    return image


# 无损、带透明（简单格式 VP8L）。
half((255, 0, 0, 255)).save(f'{out}/lossless-alpha.webp', 'WEBP', lossless=True)
# 有损、带透明（扩展格式 VP8X + ALPH + VP8）。
half((0, 128, 255, 255)).save(f'{out}/lossy-alpha.webp', 'WEBP', quality=90, alpha_quality=100)
# 有损、不透明（简单格式 VP8）。
Image.new('RGB', (W, H), (0, 160, 0)).save(f'{out}/opaque-lossy.webp', 'WEBP', quality=90)
# 动图：三帧，第一帧左半红色，之后整幅蓝色、绿色；转换只取第一帧。
frames = [half((255, 0, 0, 255)), Image.new('RGBA', (W, H), (0, 0, 255, 255)), Image.new('RGBA', (W, H), (0, 255, 0, 255))]
frames[0].save(f'{out}/animated.webp', 'WEBP', save_all=True, append_images=frames[1:], duration=200, loop=0, lossless=True)
# 随机噪声（有损、质量 5）：文件很小，转成 PNG 后约 4 MB，用来测试转换后的大小重新计入输入合计与 docx 上限。
import random

random.seed(7)
noise = Image.frombytes('RGB', (1000, 1000), bytes(random.getrandbits(8) for _ in range(1000 * 1000 * 3)))
noise.save(f'{out}/noise.webp', 'WEBP', quality=5)
