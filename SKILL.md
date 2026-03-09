---
name: clip-skill
description: |
  用嘴剪音视频。上传音频或视频文件，用自然语言告诉 AI 要剪掉什么，自动完成剪辑并发布到你的 PodAha 账号。

  Upload an audio/video file to PodAha, tell the AI what to cut in plain language, and get a clean edited result published to your account.

  Requires a Personal Access Token from podaha.com to bind results to your account.
keywords:
  - audio
  - video
  - podcast
  - clip
  - editing
  - transcription
  - 剪辑
  - 音频
license: MIT
allowed-tools:
  - Bash
metadata:
  clawdbot:
    requires:
      bins:
        - node
    setup:
      - prompt: |
          使用 clip-skill 需要一个 **PodAha 个人访问 Token**，用来把剪辑结果绑定到你的账号。

          获取步骤：
          1. 注册登录 https://podaha.com （免费）
          2. 进入 Settings → API Tokens
          3. 点击「创建 Token」，复制（格式为 `pat_` 开头）

          然后配置：
          ```bash
          cp .env.example .env
          # 编辑 .env，填入：
          # CLIP_SKILL_TOKEN=pat_你的token
          ```

          或者直接通过环境变量传入：
          ```bash
          CLIP_SKILL_TOKEN=pat_xxx node scripts/run.mjs --file 音频.mp3
          ```

          配置好后运行 smoke test 验证：
          ```bash
          node scripts/smoke.mjs
          ```
          看到 `All checks passed ✓` 即可使用。
---

## 能做什么

用一句话告诉 AI 要怎么剪，它自动找到对应片段、剪掉或提取，结果发布到你的 podaha.com 账号。

**支持两种模式：**
- `clip`（默认）：删除不要的片段，保留干净音频
- `quote`：提取精彩片段，拼成高光音频

---

## 用法示例

### 自动去除口头禅/停顿
```bash
node scripts/run.mjs --file 播客.mp3
```

### 按语义删除指定内容
```bash
node scripts/run.mjs --file 访谈.mp3 --instruction "把前面讲吃饭的部分去掉"
node scripts/run.mjs --file 录音.mp3 --instruction "把所有那个那个、就是就是去掉"
node scripts/run.mjs --file 课程.mp3 --instruction "去掉调试设备的那段开头"
```

### 按时间段截取
```bash
# 去掉前3分钟（保留 180s 之后的内容）
node scripts/run.mjs --file 直播.mp3 --start 180

# 只保留 10–18 分钟
node scripts/run.mjs --file 访谈.mp3 --start 600 --end 1080
```

### 提取金句高光音频
```bash
node scripts/run.mjs --file 访谈.mp3 --mode quote
node scripts/run.mjs --file 演讲.mp3 --mode quote --instruction "提取情绪最强、最有爆发力的片段"
```

### 视频文件（自动提取音轨）
```bash
node scripts/run.mjs --file 直播录像.mp4 --instruction "把聊天互动环节去掉，只留干货讲解"
```

---

## 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--file` | 音频或视频文件路径（必填） | — |
| `--instruction` | 自然语言剪辑指令（中英文均可） | 自动检测 |
| `--mode` | `clip`（删片段）或 `quote`（提取金句） | `clip` |
| `--start` | 保留内容的起始秒数（时间截取用） | — |
| `--end` | 保留内容的截止秒数（时间截取用） | — |
| `--language` | 转录语言 | `zh` |

---

## Auth / 账号绑定

每次运行都会把结果绑定到你的 PodAha 账号，在 https://podaha.com 登录后可以：
- 在线收听剪辑结果
- 下载成品 MP3
- 查看转录文字
- 继续二次编辑

**获取 Token：**
1. 注册登录 **https://podaha.com**（免费）
2. 进入 **Settings → API Tokens**
3. 创建 Token（`pat_` 开头），填入 `.env`

---

## Smoke test

```bash
node scripts/smoke.mjs
```

预期输出：
```
[smoke] /api/auth/me ok — email: you@example.com
[smoke] /api/audio ok, items: 3
[smoke] All checks passed ✓
```

---

## 后端依赖（自托管时需要）

macOS:
```bash
brew install ffmpeg
python3 -m pip install -U openai-whisper
```

Ubuntu / Debian:
```bash
sudo apt-get install -y ffmpeg python3 python3-pip
python3 -m pip install -U openai-whisper
```

---

## 常见错误排查

| 错误 | 原因 | 解决 |
|------|------|------|
| `Missing env CLIP_SKILL_TOKEN` | Token 未配置 | `cp .env.example .env` 并填入 token |
| `HTTP 401` | Token 失效或被撤销 | 去 podaha.com/tokens 重新创建 |
| transcription 卡住 | 后端未安装 Whisper | 服务器安装 openai-whisper |
| `no quotes found` | 音频内容较平淡 | 换一个 `--instruction` 描述你想要的风格 |
