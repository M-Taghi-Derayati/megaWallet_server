import { ethers, Contract, Log } from 'ethers';
import { BlockchainRegistry, NetworkConfig } from '../config/BlockchainRegistry'; // فرض بر وجود NetworkConfig
import PhoenixContractAbi from '../abi/phoenixAbi.json';
import { TradeExecutionService } from '../services/TradeExecutionService';

const registry = new BlockchainRegistry();
// یک نمونه از TradeExecutionService می‌سازیم تا رویدادها را به آن ارسال کنیم
const tradeExecutor = new TradeExecutionService();

// تعریف ساختار داده برای رویداد جهت خوانایی بهتر
interface NativeTradeEventArgs {
    user: string;
    amount: bigint;
    quoteId: string; // این به صورت bytes32 می‌آید
    blockNumber: number;
    txHash: string;
}

export class EvmEventMonitorWorker {

    /**
     * Worker را برای تمام شبکه‌های EVM پیکربندی شده، شروع می‌کند.
     */
    public start(): void {
        console.log('✅ EVM Event Monitor Worker starting...');

        // متد getAllEvmNetworks را باید به BlockchainRegistry اضافه کنیم
        const networksToMonitor = registry.getNetworksByType("EVM")

        if (networksToMonitor.length === 0) {
            console.warn("[EVM Monitor] No EVM networks with WebSocket URL found to monitor.");
            return;
        }

        networksToMonitor.forEach(network => {
            this.listenToNetwork(network);
        });
    }

    /**
     * یک listener برای یک شبکه خاص راه‌اندازی می‌کند.
     */
    private listenToNetwork(network: NetworkConfig): void {
        if (!network.webSocketUrl || !network.phoenixContractAddress) {
            console.log(`[EVM Monitor] Skipping ${network.name} due to missing websocket or contract address.`);
            return;
        }

        try {
            // برای گوش دادن مداوم، استفاده از WebSocketProvider ضروری است
            const provider = new ethers.WebSocketProvider(network.webSocketUrl);
            const contract = new Contract(network.phoenixContractAddress, PhoenixContractAbi, provider);

            console.log(`[EVM Monitor] Subscribed to "NativeTradeInitiated" events on ${network.name} (${network.phoenixContractAddress})`);

            // گوش دادن به رویداد "NativeTradeInitiated"
            contract.on("NativeTradeInitiated", (user, amount, quoteId, event: Log) => {

                console.log(`[EVM Monitor] ❗️ Event received on ${network.name}!`);

                // استخراج و نمایش داده‌های رویداد
                const eventArgs: NativeTradeEventArgs = {
                    user,
                    amount,
                    quoteId,
                    blockNumber: event.blockNumber,
                    txHash: event.transactionHash
                };

                this.logEvent(eventArgs);

                // فراخوانی سرویس اجرای معامله با داده‌های رویداد
                tradeExecutor.executeNativeSwapFromEvent({
                    ...eventArgs,
                    networkId: network.id
                });
            });

            // ethers v6 به صورت خودکار تلاش برای اتصال مجدد (reconnect) را انجام می‌دهد.
            // ما می‌توانیم به رویدادهای "network" و "error" گوش دهیم تا از وضعیت مطلع شویم.

            provider.on("network", (newNetwork, oldNetwork) => {
                if (oldNetwork) {
                    console.log(`[EVM Monitor] WebSocket for ${network.name} reconnected. Chain ID: ${newNetwork.chainId}`);
                } else {
                    console.log(`[EVM Monitor] WebSocket for ${network.name} connected. Chain ID: ${newNetwork.chainId}`);
                }
            });

            provider.on("error", (error) => {
                // این رویداد زمانی رخ می‌دهد که یک خطای کلی در provider رخ دهد.
                console.error(`[EVM Monitor] Provider error on ${network.name}:`, error);
            });

            // دسترسی مستقیم به آبجکت websocket دیگر توصیه نمی‌شود، اما اگر نیاز به
            // مدیریت دستی بسته‌شدن داشتیم، باید از این طریق باشد:

            const websocket = (provider as any).websocket;
            let pingTimeout: NodeJS.Timeout;
            if (websocket) {
                const connect = () => {
                    try {
                        const provider = new ethers.WebSocketProvider(network.webSocketUrl);
                        const contract = new Contract(network.phoenixContractAddress, PhoenixContractAbi, provider);

                        console.log(`[EVM Monitor] Subscribing to events on ${network.name}...`);

                        contract.on("NativeTradeInitiated", (user, amount, quoteId, event: Log) => {
                            // ... (منطق پردازش رویداد)
                        });

                        // --- بخش جدید و کلیدی: مدیریت Ping/Pong و اتصال مجدد ---

                        const heartbeat = () => {
                            console.log(`[EVM Monitor] Sending ping to ${network.name}...`);
                            // اگر WebSocket آماده نبود، خاتمه بده
                            if (websocket.readyState !== 1) return;

                            // یک تایمر برای قطع اتصال در صورت عدم دریافت pong
                            pingTimeout = setTimeout(() => {
                                console.warn(`[EVM Monitor] Pong not received from ${network.name}. Terminating connection.`);
                                websocket.terminate(); // اتصال را به زور قطع کن تا ethers.js دوباره تلاش کند
                            }, 10000); // ۱۰ ثانیه منتظر pong بمان

                            websocket.ping();
                        }

                        websocket.on('open', () => {
                            console.log(`[EVM Monitor] WebSocket connection opened for ${network.name}. Starting heartbeat.`);
                            // هر ۳۰ ثانیه یک پینگ بفرست
                            setInterval(heartbeat, 20000);
                        });

                        websocket.on('pong', () => {
                            // هر بار که pong دریافت می‌کنیم، یعنی اتصال زنده است
                             console.log(`[EVM Monitor] Pong received from ${network.name}.`);
                            clearTimeout(pingTimeout); // تایمر قطع اتصال را لغو کن
                        });

                        websocket.on('close', (code: number) => {
                            console.warn(`[EVM Monitor] WebSocket for ${network.name} closed (code: ${code}). Reconnecting...`);
                            // Ethers به صورت خودکار تلاش می‌کند، اما ما هم می‌توانیم یک تلاش مجدد دستی را اینجا فعال کنیم
                            setTimeout(connect, 5000); // ۵ ثانیه بعد دوباره تلاش کن
                        });

                        websocket.on('error', (error: Error) => {
                            console.error(`[EVM Monitor] WebSocket error on ${network.name}:`, error.message);
                        });

                    } catch (error) {
                        console.error(`[EVM Monitor] Failed to start listener for ${network.name}:`, error);
                    }
                };

                connect();
            }


        } catch (error) {
            console.error(`[EVM Monitor] Failed to start listener for ${network.name}:`, error);
        }
    }



    /**
     * یک متد کمکی برای لاگ کردن خوانای رویداد.
     */
    private logEvent(args: NativeTradeEventArgs): void {
        try {
            console.log(`   - User: ${args.user}`);
            console.log(`   - Amount: ${ethers.formatEther(args.amount)} ETH`);
            // ethers.decodeBytes32String ممکن است در صورت padding نبودن کامل، خطا دهد
            console.log(`   - Quote ID (Hex): ${args.quoteId}`);
            console.log(`   - Tx Hash: ${args.txHash}`);
        } catch(e) {
            console.error("Error logging event details:", e);
        }
    }
}