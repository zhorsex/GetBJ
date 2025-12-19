# Hydration Price Monitor (价格监控报警系统)

基于 GalacticCouncil (Hydration) SDK 开发的多币对价格监控程序，具备邮件实时预警、整点播报及自动重连功能。

## 🌟 核心功能

- **多币对实时监控**：支持同时监控多个币对（如 KSM/DOT, vDOT/DOT, DOT/USDT 等）。
- **智能预警系统**：
  - **即时通知**：当波动超过预设阈值时，第一时间发出邮件。
  - **节流合并**：在高频变动时，自动将 6 秒内的多条通知合并为一封汇总邮件，防止骚扰。
  - **发件容错**：支持配置多个发件邮箱，主邮箱失效时自动切换到备用邮箱。
- **自动化运行报告**：
  - **整点播报**：每小时自动发送一份当前所有监控币对的价格汇总报告。
  - **自检报告**：程序启动时及重连成功后，自动发送系统状态报告。
- **高可用抗风险**：
  - **健康检查**：内置每分钟一次的 RPC 节点健康检查。
  - **自动重连**：当连接断开、节点超时或程序异常时，具备完善的清理与自动指数重连逻辑。
  - **稳定期保护**：重连后的最初 60 秒内只记录价格不发送预警，防止网路延迟导致的数据波动误报。

## 🛠️ 环境要求

- **Node.js**: v16 或更高版本
- **NPM**: 随 Node.js 一起安装

## 🚀 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 配置说明
在根目录下创建或修改 `config.json` 文件。**由于包含敏感信息，该文件已被添加到 `.gitignore`。**

```json
{
  "recipientEmail": "your-receiver@example.com",
  "queueDelay": 6000,
  "senders": [
    {
      "name": "通知号1",
      "host": "smtp.example.com",
      "port": 465,
      "secure": true,
      "user": "sender1@example.com",
      "pass": "your-smtp-password"
    },
    {
      "name": "通知号2",
      "host": "smtp.example.com",
      "port": 465,
      "secure": true,
      "user": "sender2@example.com",
      "pass": "your-smtp-password"
    }
  ]
}
```

### 3. 运行程序
```bash
npm start
```

## 📝 监控配置

你可以在 `monitor.js` 的 `PAIRS` 数组中自定义需要监控的币对及阈值：

```javascript
const PAIRS = [
    {
        name: 'KSM/DOT',
        assetIn: '1000771', // 卖出币种 ID
        assetOut: '5',       // 买入币种 ID
        threshold: 0.01      // 价格变动触发阈值
    },
    // ...
];
```

## 📄 开源协议
ISC
