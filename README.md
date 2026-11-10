# DSH Voice Input · 语音输入

<img src="assets/icon-180.png" width="96" height="96" alt="DSH Voice Input">

给 DSH 输入框加一个麦克风按钮：说一句话，文字直接落进草稿。

![screenshot](assets/screenshot.png)

## 特性

- 按钮在输入框「模型选择器」右侧，28×28 的小图标，不展开、不挤占工具栏
- 点一下开始录音，再点一下（或按 **空格**）结束；识别结果插入光标位置，可按 Ctrl+Z 撤销
- 只依赖豆包（火山引擎）流式语音识别，**填一个 API Key 就能用**，新用户有 20 小时免费额度
- API Key 存在 DSH 凭据库里，不下发到浏览器、不写进配置文件
- 识别在 Host 侧发起 WebSocket，浏览器只负责录音和上传 PCM

## 安装

把仓库 clone 到本地任意目录，然后让 DSH 用 `plugin_manager` 安装这个目录：

```
plugin_manager install_bundle target=<clone 下来的目录>
```

安装后插件立即生效，输入框右侧出现麦克风图标。

## 配置

第一次点麦克风会自动弹窗，填两样东西：

| 字段 | 说明 |
| --- | --- |
| API Key | 火山引擎「语音技术」控制台的豆包语音识别 API Key |
| Resource ID | 默认 `volc.seedasr.sauc.duration`，一般不用改 |

之后想换 Key，**右键**那个麦克风按钮就能重新打开弹窗。

## 使用

1. 点麦克风（浏览器第一次会问麦克风权限）
2. 说话
3. 再点一下按钮或敲 **空格** 结束
4. 文字插入草稿，按 Ctrl+Z 可撤销

录音时按空格只会结束录音，不会往草稿里多打一个空白。

## 实现

- 端点：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`（大模型流式 ASR 2.0）
- 音频：16 kHz / 16 bit / 单声道，浏览器上传裸 PCM，Host 侧补 44 字节 WAV 头
- 标点、ITN、语义顺滑全开，结果按 `result.text` 增量返回
- 握手鉴权三个头：`X-Api-Key`、`X-Api-Resource-Id`、`X-Api-Request-Id`

## 目录

```
index.js          Host 半：凭据读写、WebSocket 客户端、二进制帧编解码、HTTP 路由
client.js         Client 半：按钮、录音采集与重采样、配置弹窗
cordis.patch.yml  bundle 注册
locale/*.json     中英文案
icon.svg          图标
```

## License

MIT

---

## English

A microphone button for the DSH composer: click, speak, and the transcript lands in your draft.

- Sits right next to the model selector, a small 28×28 icon that never expands the toolbar.
- Click to start, click again or press **Space** to stop; text is inserted at the caret and is undoable.
- Only needs a Doubao (Volcengine) speech-to-text API key — new accounts get 20 free hours.
- The key is stored in the DSH credential store, never sent to the browser or written to config files.
- The WebSocket runs on the host side; the browser only records and uploads PCM.

Install: clone the repo, then `plugin_manager install_bundle target=<clone dir>`.
Configure: click the button once and paste your API key (right-click to change it later).

MIT licensed.
