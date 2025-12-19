const { createSdkContext } = require('@galacticcouncil/sdk');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const sendEmail = require('./aitomail.cjs');

// 配置
const NODE_URL = 'wss://hydration-rpc.n.dwellir.com';
const POLL_INTERVAL_MS = 30000; // 30 秒
const RECONNECT_DELAY_MS = 15000; // 重连延迟 15 秒
const HEALTH_CHECK_INTERVAL_MS = 60000; // 健康检查间隔 60 秒

// 定义要监控的多个币对
const PAIRS = [
    {
        name: 'KSM/DOT',
        assetIn: '1000771', // KSM
        assetOut: '5',       // DOT
        threshold: 0.01
    },
    // 在此处添加更多币对，示例：
    {
        name: 'vDOT/DOT',
        assetIn: '15', // vDOT
        assetOut: '5',   // DOT
        threshold: 0.005
    },
    {
        name: 'DOT/usdt',
        assetIn: '5', // DOT
        assetOut: '10',   // usdt
        threshold: 0.01
    },
    {
        name: 'ksm/usdt',
        assetIn: '1000771', // ksm
        assetOut: '10',   // usdt
        threshold: 0.01
    },

];

let api = null;
let sdk = null;
let provider = null;
let isConnected = false;
let isReconnecting = false;
let monitorIntervalId = null;
let healthCheckIntervalId = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 10;
let disconnectedCount = 0; // 连续断线计数
const MAX_DISCONNECTED_COUNT = 600; // 最大允许断线次数（600次健康检查 = 600分钟）
let lastConnectTime = 0; // 上次连接时间
const STABILIZATION_PERIOD_MS = 60000; // 重连后稳定期 60 秒

// 跟踪每个币对参考价格的状态
const pairStates = new Map(); // 键：币对名称，值：{ referencePrice: 数字 }

// 整点播报相关
let lastHourlyReportHour = -1; // 跟踪上次播报的小时，-1表示尚未播报

// ==================== 全局异常处理 ====================
process.on('uncaughtException', (error) => {
    console.error('[FATAL] Uncaught Exception:', error);
    // 尝试发送错误通知
    try {
        sendEmail('JGJK - 严重错误', `程序发生未捕获异常:\n${error.stack || error.message}`);
    } catch (e) {
        console.error('Failed to send error email:', e);
    }
    // 延迟退出，让邮件发送完成
    setTimeout(() => {
        process.exit(1);
    }, 5000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
    consecutiveErrors++;
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[FATAL] Too many consecutive errors (${consecutiveErrors}), triggering reconnect...`);
        triggerReconnect();
    }
});

// 检查是否需要发送整点播报
function shouldSendHourlyReport() {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // 在整点前后5分钟内（如 55-05 分钟范围）且本小时还未播报
    if (currentHour !== lastHourlyReportHour && currentMinute <= 5) {
        return true;
    }
    return false;
}

// 发送整点价格报告
async function sendHourlyReport() {
    const now = new Date();
    const currentHour = now.getHours();

    let reportMessage = `📊 整点价格报告 (${now.toLocaleString('zh-CN')})\n\n`;

    for (const pair of PAIRS) {
        const priceData = await getSpotPrice(pair.assetIn, pair.assetOut);
        if (priceData) {
            const currentPrice = formatPrice(priceData);
            const state = pairStates.get(pair.name);
            const refPrice = state?.referencePrice;

            if (refPrice) {
                const diff = currentPrice - refPrice;
                const diffPercent = ((diff / refPrice) * 100).toFixed(2);
                const arrow = diff >= 0 ? '📈' : '📉';
                reportMessage += `${arrow} ${pair.name}: ${currentPrice.toFixed(4)} (基准: ${refPrice.toFixed(4)}, ${diff >= 0 ? '+' : ''}${diffPercent}%)\n`;
            } else {
                reportMessage += `📌 ${pair.name}: ${currentPrice.toFixed(4)}\n`;
            }
        } else {
            reportMessage += `❌ ${pair.name}: 获取价格失败\n`;
        }
    }

    sendEmail('JGJK - 整点播报', reportMessage);
    lastHourlyReportHour = currentHour;
    console.log(`Hourly report sent at ${now.toLocaleTimeString()}`);
}

// ==================== 清理和重连逻辑 ====================
async function cleanup() {
    console.log('[CLEANUP] Cleaning up resources...');
    isConnected = false;

    if (monitorIntervalId) {
        clearInterval(monitorIntervalId);
        monitorIntervalId = null;
    }

    if (healthCheckIntervalId) {
        clearInterval(healthCheckIntervalId);
        healthCheckIntervalId = null;
    }

    if (sdk) {
        try {
            sdk.destroy();
        } catch (e) {
            console.error('[CLEANUP] Error destroying SDK:', e);
        }
        sdk = null;
    }

    if (api) {
        try {
            await api.disconnect();
        } catch (e) {
            console.error('[CLEANUP] Error disconnecting API:', e);
        }
        api = null;
    }

    if (provider) {
        try {
            await provider.disconnect();
        } catch (e) {
            console.error('[CLEANUP] Error disconnecting provider:', e);
        }
        provider = null;
    }

    console.log('[CLEANUP] Cleanup complete.');
}

async function triggerReconnect() {
    if (isReconnecting) {
        console.log('[RECONNECT] Already reconnecting, skipping...');
        return;
    }

    isReconnecting = true;
    console.log(`[RECONNECT] Will reconnect in ${RECONNECT_DELAY_MS / 1000} seconds...`);

    await cleanup();

    setTimeout(async () => {
        isReconnecting = false;
        consecutiveErrors = 0;
        await connect();
    }, RECONNECT_DELAY_MS);
}

let isFirstConnect = true; // 标记是否为首次连接

// ... (省略部分代码)

// 健康检查函数
async function healthCheck() {
    // 如果未连接，检查是否需要触发重连
    if (!isConnected || !api) {
        disconnectedCount++;
        console.log(`[HEALTH] Not connected (${disconnectedCount}/${MAX_DISCONNECTED_COUNT}), waiting for auto-reconnect...`);

        // 断线重连失败提醒 (每5次提醒一次，避免刷屏)
        if (disconnectedCount % 5 === 0) {
            const msg = `⚠️ 警告: 已断开连接 ${(disconnectedCount * HEALTH_CHECK_INTERVAL_MS) / 60000} 分钟，正在尝试重连...`;
            console.error('[HEALTH] ' + msg);
            try {
                sendEmail('JGJK - 连接断开警告', msg);
            } catch (e) { console.error('Failed to send alert email:', e); }
        }

        // 如果断线时间过长，主动触发重连
        if (disconnectedCount >= MAX_DISCONNECTED_COUNT) {
            console.error('[HEALTH] Disconnected for too long, triggering manual reconnect...');
            disconnectedCount = 0;
            triggerReconnect();
        }
        return;
    }

    // 已连接，重置断线计数
    disconnectedCount = 0;

    try {
        // 尝试获取链上最新区块作为健康检查
        const header = await Promise.race([
            api.rpc.chain.getHeader(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 10000))
        ]);

        console.log(`[HEALTH] OK - Block #${header.number.toNumber()}`);
        consecutiveErrors = 0; // 重置错误计数
    } catch (error) {
        console.error('[HEALTH] Health check failed:', error.message);
        consecutiveErrors++;

        if (consecutiveErrors >= 3) {
            console.error('[HEALTH] Multiple health check failures, triggering reconnect...');
            triggerReconnect();
        }
    }
}

async function connect() {
    try {
        console.log(`[CONNECT] Connecting to ${NODE_URL}...`);
        provider = new WsProvider(NODE_URL, 5000); // 5秒自动重连

        // 重连日志
        provider.on('disconnected', () => {
            console.log('[WS] Disconnected from node. Auto-reconnect will be attempted by WsProvider...');
            isConnected = false;
            // 重置断线计数，让健康检查开始计时
            disconnectedCount = 0;
        });

        provider.on('connected', () => {
            console.log('[WS] Connected to node.');
            isConnected = true;
            consecutiveErrors = 0;
        });

        provider.on('error', (error) => {
            console.error('[WS] Connection error:', error.message);
            consecutiveErrors++;
        });

        api = await ApiPromise.create({ provider });

        // 等待 API 准备就绪
        await api.isReady;

        sdk = await createSdkContext(api);
        console.log('[CONNECT] SDK initialized successfully.');

        // 发送重连成功提醒（跳过首次启动）
        if (!isFirstConnect) {
            try {
                sendEmail('JGJK - 重连成功', `✅ 服务已重新连接\n时间: ${new Date().toLocaleString('zh-CN')}`);
            } catch (e) { console.error('Failed to send success email:', e); }
        }
        isFirstConnect = false;

        // 记录连接时间，用于稳定期检测
        lastConnectTime = Date.now();
        console.log(`[CONNECT] Stabilization period started: ${STABILIZATION_PERIOD_MS / 1000}s before alert processing.`);

        // 初始化状态（如果尚未初始化）
        PAIRS.forEach(pair => {
            if (!pairStates.has(pair.name)) {
                pairStates.set(pair.name, { referencePrice: null });
            }
        });

        // 开始监控循环
        monitorLoop();

        // 开始健康检查
        if (healthCheckIntervalId) {
            clearInterval(healthCheckIntervalId);
        }
        healthCheckIntervalId = setInterval(healthCheck, HEALTH_CHECK_INTERVAL_MS);

    } catch (error) {
        console.error('[CONNECT] Failed to initialize:', error.message);

        // 如果是初始化失败，且连续错误较多，也发送邮件提醒
        if (consecutiveErrors > 0 && consecutiveErrors % 5 === 0) {
            try {
                sendEmail('JGJK - 初始化失败', `❌ 无法连接到节点，正在重试...\n错误: ${error.message}`);
            } catch (e) { }
        }

        // 如果初始连接失败，延迟后重试连接
        console.log(`[CONNECT] Will retry in ${RECONNECT_DELAY_MS / 1000} seconds...`);
        setTimeout(connect, RECONNECT_DELAY_MS);
    }
}

async function getSpotPrice(assetIn, assetOut) {
    if (!sdk || !isConnected) return null;
    try {
        const spotPrice = await sdk.api.router.getBestSpotPrice(assetIn, assetOut);
        return spotPrice;
    } catch (error) {
        console.error(`[PRICE] Error fetching spot price for ${assetIn}/${assetOut}:`, error.message);
        return null;
    }
}

// 检查价格是否有效（非 0，非 NaN，合理范围内）
function isValidPrice(price, pairName) {
    if (price === null || price === undefined || isNaN(price)) {
        return false;
    }
    if (price <= 0) {
        console.warn(`[PRICE] Invalid price for ${pairName}: ${price} (跳过)`);
        return false;
    }
    return true;
}

// 检查是否在稳定期内
function isInStabilizationPeriod() {
    const elapsed = Date.now() - lastConnectTime;
    if (elapsed < STABILIZATION_PERIOD_MS) {
        console.log(`[STABILIZATION] Still in stabilization period (${Math.round(elapsed / 1000)}s / ${STABILIZATION_PERIOD_MS / 1000}s)`);
        return true;
    }
    return false;
}

function formatPrice(priceData) {
    if (!priceData) return null; // 返回 null 而不是 0，便于区分
    if (typeof priceData.toDecimal === 'function') {
        const price = parseFloat(priceData.toDecimal());
        return isNaN(price) ? null : price;
    }
    // 如果缺少 toDecimal 方法的备用方案
    if (priceData.amount && priceData.decimals !== undefined) {
        const price = Number(priceData.amount) / Math.pow(10, priceData.decimals);
        return isNaN(price) ? null : price;
    }
    // 如果只是数字或字符串的备用方案
    const price = parseFloat(priceData);
    return isNaN(price) ? null : price;
}

async function monitorLoop() {
    // 如果需要，对所有币对进行初始获取
    let statusMessage = "监控程序已启动 (Monitor Started)\n\n";
    let hasUpdates = false;

    for (const pair of PAIRS) {
        const state = pairStates.get(pair.name);
        if (!state.referencePrice) {
            try {
                const priceData = await getSpotPrice(pair.assetIn, pair.assetOut);
                if (priceData) {
                    const price = formatPrice(priceData);
                    state.referencePrice = price;
                    console.log(`[INIT] ${pair.name} Price: ${price.toFixed(4)}`);
                    statusMessage += `✅ ${pair.name}: ${price.toFixed(4)}\n`;
                    hasUpdates = true;
                } else {
                    console.log(`[INIT] Failed to fetch price for ${pair.name}`);
                    statusMessage += `❌ ${pair.name}: 获取价格失败 (Failed)\n`;
                    hasUpdates = true;
                }
            } catch (error) {
                console.error(`[INIT] Error fetching ${pair.name}:`, error.message);
                statusMessage += `❌ ${pair.name}: 错误 - ${error.message}\n`;
                hasUpdates = true;
            }
        }
    }

    if (hasUpdates) {
        sendEmail('JGJK - 自检报告', statusMessage);
    }

    // 清除旧的监控间隔（如果存在）
    if (monitorIntervalId) {
        clearInterval(monitorIntervalId);
    }

    monitorIntervalId = setInterval(async () => {
        // 包裹在 try-catch 中防止异常逃逸
        try {
            if (!sdk || !isConnected) {
                console.log('[MONITOR] Not connected, skipping this cycle.');
                return;
            }

            // 检查是否需要发送整点播报
            if (shouldSendHourlyReport()) {
                try {
                    await sendHourlyReport();
                } catch (error) {
                    console.error('[MONITOR] Error sending hourly report:', error.message);
                }
            }

            // 检查是否在稳定期
            const inStabilization = isInStabilizationPeriod();

            for (const pair of PAIRS) {
                try {
                    const priceData = await getSpotPrice(pair.assetIn, pair.assetOut);
                    const currentPrice = formatPrice(priceData);

                    // 检查价格有效性
                    if (!isValidPrice(currentPrice, pair.name)) {
                        continue;
                    }

                    console.log(`[PRICE] ${pair.name}: ${currentPrice.toFixed(4)}`);

                    const state = pairStates.get(pair.name);

                    // 如果在稳定期，只更新参考价格，不进行比较
                    if (inStabilization) {
                        state.referencePrice = currentPrice;
                        continue;
                    }

                    if (state.referencePrice) {
                        const diff = Math.abs(currentPrice - state.referencePrice);
                        if (diff >= pair.threshold) {
                            const message = `Old: ${state.referencePrice.toFixed(4)} \nNew: ${currentPrice.toFixed(4)} \n ${pair.name} 价格变动 ${diff.toFixed(4)}。`;
                            console.log(`[ALERT] ${message}`);

                            // 发送邮件
                            sendEmail('JGJK', message);

                            // 更新参考价格
                            state.referencePrice = currentPrice;
                        }
                    } else {
                        // 如果之前获取初始价格失败，现在设置它
                        state.referencePrice = currentPrice;
                        console.log(`[INIT] ${pair.name} Price set to: ${state.referencePrice.toFixed(4)}`);
                    }
                } catch (pairError) {
                    console.error(`[MONITOR] Error processing ${pair.name}:`, pairError.message);
                    consecutiveErrors++;
                }
            }

            // 重置连续错误计数（如果循环完成没有问题）
            consecutiveErrors = 0;

        } catch (error) {
            console.error('[MONITOR] Unexpected error in monitor loop:', error.message);
            consecutiveErrors++;

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                console.error(`[MONITOR] Too many errors (${consecutiveErrors}), triggering reconnect...`);
                triggerReconnect();
            } else if (consecutiveErrors % 5 === 0) {
                // 连续错误报警
                const msg = `⚠️ 警告: 监控循环已连续出错 ${consecutiveErrors} 次，请检查日志。\n最新错误: ${error.message}`;
                try {
                    sendEmail('JGJK - 监控故障警告', msg);
                } catch (e) { }
            }
        }

    }, POLL_INTERVAL_MS);

    console.log('[MONITOR] Monitor loop started.');
}

// 处理脚本终止以进行清理
process.on('SIGINT', async () => {
    console.log('[EXIT] Received SIGINT, stopping monitor...');
    await cleanup();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('[EXIT] Received SIGTERM, stopping monitor...');
    await cleanup();
    process.exit(0);
});

// 启动
connect();
