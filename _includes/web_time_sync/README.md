# web_time_sync

一个可单独部署/启动的网页工具：仅用于 **连接 BLE 标签 / 断开 / 同步时间**。

## 功能

- 连接 BLE 标签（Web Bluetooth）
- 断开 BLE 标签
- 同步时间（按钮触发）
- 页面后台自动获取“准确时间”（用户无需操作）：
  - 优先：HTTPS 时间 API（UTC）
  - 失败：回退为本机系统时间
- 时区处理：通过“时区偏移(小时)”设置要写入标签的本地时区（默认取浏览器本地时区）

> 说明：当前固件的 RxTx 通道只有写入命令（`0xDD` 设置时间），没有“读取标签当前时间”的命令/通知，因此无法可靠判断“与 NTP 相差超过 30 秒再自动同步”。本工具保留为手动点“同步时间”。

## 运行方式

Web Bluetooth 要求页面在 **HTTPS 或 localhost** 下运行。

任选一种：

1) VS Code：使用 Live Server 扩展打开 `index.html`

2) Python：在仓库根目录执行

- `python -m http.server 8000`

然后浏览器访问：

- `http://localhost:8000/`

## 协议

与 @miemiekurisu 的固件配套使用