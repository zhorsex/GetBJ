const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ========== 加载配置 ==========
let config;
try {
    const configPath = path.join(__dirname, 'config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
    console.error('Failed to load config.json:', error.message);
    process.exit(1);
}

const RECIPIENT_EMAIL = config.recipientEmail;
const QUEUE_DELAY = config.queueDelay || 6000;
const senders = config.senders || [];

var open = 1; // 开关，1开
var jishuqi = 0; // 当前使用的发件箱索引

// 创建发送邮件的对象数组
const transporters = senders.map(sender => ({
    instance: nodemailer.createTransport({
        host: sender.host,
        port: sender.port,
        secure: sender.secure,
        auth: {
            user: sender.user,
            pass: sender.pass
        }
    }),
    config: sender
}));

// 邮件队列配置
let emailQueue = [];
let queueTimer = null;

// 实际发送邮件的内部函数
function _sendEmailNow(subject, content) {
    if (transporters.length === 0) {
        console.error('没有配置发件邮箱！');
        return false;
    }

    if (open !== 1) {
        console.log('邮件发送未开启！');
        return false;
    }

    // 获取当前轮到的发件箱
    const currentIndex = jishuqi % transporters.length;
    const { instance, config: senderConfig } = transporters[currentIndex];

    // 记录尝试次数，防止死循环
    const attemptCount = (arguments[2] || 0) + 1;
    if (attemptCount > transporters.length) {
        console.error('所有配置的邮箱均发送失败，停止重试。');
        return false;
    }

    let mailObj = {
        from: `"${senderConfig.name}" <${senderConfig.user}>`, // 发件人
        to: RECIPIENT_EMAIL, // 收件人
        subject: subject, // 主题
        text: content.toString() // 内容
    };

    // 发送邮件
    instance.sendMail(mailObj, (err, data) => {
        if (err) {
            console.log(`[${senderConfig.name}] 发送失败:`, err.message);
            jishuqi += 1; // 切换邮箱
            console.log('》》》切换邮箱并尝试重新发送...《《《');
            _sendEmailNow(subject, content, attemptCount); // 回调重发
        } else {
            console.log(`[${senderConfig.name}] 邮件发送成功！`);
        }
    });
}

// 处理队列，合并发送
function processQueue() {
    if (emailQueue.length === 0) {
        queueTimer = null;
        return;
    }

    // 合并邮件
    const firstEmail = emailQueue[0];
    let combinedSubject = firstEmail.subject;
    let combinedContent = '';

    if (emailQueue.length === 1) {
        // 只有一条消息，直接发送
        combinedContent = firstEmail.content;
    } else {
        // 多条消息，合并发送
        combinedSubject = `${firstEmail.subject} (${emailQueue.length}条消息)`;
        combinedContent = `收到${emailQueue.length}条价格变动通知：\n\n`;

        emailQueue.forEach((email, index) => {
            const timestamp = new Date(email.timestamp).toLocaleString('zh-CN', {
                hour12: false,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            combinedContent += `[${index + 1}] ${timestamp}\n${email.content}\n\n`;
        });
    }

    console.log(`发送合并邮件，包含 ${emailQueue.length} 条消息`);
    _sendEmailNow(combinedSubject, combinedContent);

    // 清空队列
    emailQueue = [];
    queueTimer = null;
}

// 对外暴露的发送邮件函数（带队列功能）
function sendEmail(subject, code) {
    const newEmail = {
        subject: subject,
        content: code.toString(),
        timestamp: Date.now()
    };

    // 如果队列为空（第一条消息），立即发送
    if (emailQueue.length === 0 && !queueTimer) {
        console.log('发送第一条消息（立即发送）');
        _sendEmailNow(newEmail.subject, newEmail.content);

        // 添加到队列用于后续可能的合并
        emailQueue.push(newEmail);

        // 设置6秒定时器，如果期间有新消息则合并发送
        queueTimer = setTimeout(() => {
            // 6秒后清空队列（如果没有新消息进来）
            emailQueue = [];
            queueTimer = null;
            console.log('队列已清空（无后续消息）');
        }, QUEUE_DELAY);
    } else {
        // 队列中已有消息，说明是后续消息，加入队列等待合并
        emailQueue.push(newEmail);
        console.log(`邮件已加入队列 (当前队列: ${emailQueue.length} 条)`);

        // 清除之前的定时器
        if (queueTimer) {
            clearTimeout(queueTimer);
        }

        // 重新设置定时器，6秒后发送合并邮件
        queueTimer = setTimeout(() => {
            if (emailQueue.length > 1) {
                // 有多条消息，发送合并邮件（不包括第一条，因为已经发送过了）
                const subsequentEmails = emailQueue.slice(1);

                let combinedSubject = `${emailQueue[0].subject} (后续${subsequentEmails.length}条变动)`;
                let combinedContent = `后续收到${subsequentEmails.length}条价格变动通知：\n\n`;

                subsequentEmails.forEach((email, index) => {
                    const timestamp = new Date(email.timestamp).toLocaleString('zh-CN', {
                        hour12: false,
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                    });
                    combinedContent += `[${index + 1}] ${timestamp}\n${email.content}\n\n`;
                });

                console.log(`发送合并邮件，包含后续 ${subsequentEmails.length} 条消息`);
                _sendEmailNow(combinedSubject, combinedContent);
            }

            // 清空队列
            emailQueue = [];
            queueTimer = null;
        }, QUEUE_DELAY);
    }
}

// 封装发送邮件的函数
// export default 默认将该方法暴漏给外部调用

module.exports = sendEmail;
// 从外部调用
//
if (typeof require !== 'undefined' && require.main === module) {
    sendEmail("测试", "正常");
}