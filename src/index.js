// Discord Bot Main Script (index.js)
import { Client, GatewayIntentBits, Collection, REST, Routes } from 'discord.js';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, collection, query, where, getDocs, deleteDoc, runTransaction } from 'firebase/firestore';

// --- Firebase & Config Setup ---
// グローバル変数が定義されていない場合のフォールバック
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};

// Firebaseの初期化
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

// 認証トークンを使用してサインイン、または匿名サインイン
async function firebaseAuth() {
    try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
            await signInWithCustomToken(auth, __initial_auth_token);
            console.log("Firebase: Signed in with custom token.");
        } else {
            await signInAnonymously(auth);
            console.log("Firebase: Signed in anonymously.");
        }
    } catch (error) {
        console.error("Firebase Auth Error:", error);
    }
}
firebaseAuth();

const userId = auth.currentUser?.uid || 'anonymous-user';

// Botのトークンは環境変数から取得
const TOKEN = process.env.DISCORD_TOKEN;

// スパム対策の設定とレートリミット設定を保存するコレクションパス
const SPAM_SETTINGS_PATH = `artifacts/${appId}/public/data/spam_settings`;
const RATE_LIMIT_PATH = `artifacts/${appId}/public/data/rate_limits`;

// --- Bot Client Setup ---
const client = new Client({
    intents: [
        // 必須のインテント
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        // 特権インテント (Developer Portalで有効化が必要)
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
    ],
});

client.commands = new Collection();
const cooldowns = new Collection();
const lastUserMessage = new Map(); // ユーザーごとの最後のメッセージ時刻を記録 (連投規制用)

// --- Command Definition and Registration ---
const commands = [
    {
        name: 'set-spam-threshold',
        description: 'スパム判定のしきい値（直近10件中、何件以上でアクション）を設定します。',
        options: [
            {
                name: 'value',
                type: 4, // Integer
                description: 'しきい値 (1-10)。例: 5 (10件中5件以上でアクション)',
                required: true,
            },
        ],
    },
    {
        name: 'set-spam-action',
        description: 'スパム検出時のアクション（削除/警告）を設定します。',
        options: [
            {
                name: 'action',
                type: 3, // String
                description: 'アクション: delete (削除) または warn (警告)',
                required: true,
                choices: [
                    { name: 'delete', value: 'delete' },
                    { name: 'warn', value: 'warn' },
                ],
            },
        ],
    },
    {
        // === 新しいミリ秒単位のレートリミットコマンド ===
        name: 'set-rate-limit',
        description: '連投規制のしきい値（ミリ秒単位）を設定します。',
        options: [
            {
                name: 'milliseconds',
                type: 4, // Integer
                description: '次のメッセージまでの最小間隔（ミリ秒）。例: 500 (0.5秒)',
                required: true,
            },
            {
                name: 'limit_action',
                type: 3, // String
                description: '規制時のアクション: delete (削除) または warn (警告)',
                required: true,
                choices: [
                    { name: 'delete', value: 'delete' },
                    { name: 'warn', value: 'warn' },
                ],
            },
        ],
    },
    {
        name: 'show-spam-settings',
        description: '現在のスパム対策とレートリミットの設定を確認します。',
    },
    {
        name: 'message-delete',
        description: '直近のメッセージを手動で削除します。',
        options: [
            {
                name: 'count',
                type: 4, // Integer
                description: '削除するメッセージの数 (1-1000)。', // ★修正: 上限を1000に変更
                required: true,
            },
        ],
    },
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

// スラッシュコマンドの登録
async function registerCommands() {
    try {
        console.log('Started refreshing application (/) commands.');
        // グローバルコマンドとして登録
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

// --- Firestore Functions ---

// スパム設定を取得
async function getSpamSettings(guildId) {
    const docRef = doc(db, SPAM_SETTINGS_PATH, guildId);
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? docSnap.data() : { threshold: 5, action: 'warn' };
}

// レートリミット設定を取得
async function getRateLimitSettings(guildId) {
    const docRef = doc(db, RATE_LIMIT_PATH, guildId);
    const docSnap = await getDoc(docRef);
    // デフォルト: 最小間隔なし、アクションは警告
    return docSnap.exists() ? docSnap.data() : { milliseconds: 0, action: 'warn' }; 
}

// スパム設定を保存
async function saveSpamSettings(guildId, threshold, action) {
    const docRef = doc(db, SPAM_SETTINGS_PATH, guildId);
    await setDoc(docRef, { threshold, action, updatedBy: userId, updatedAt: new Date() });
}

// レートリミット設定を保存
async function saveRateLimitSettings(guildId, milliseconds, action) {
    const docRef = doc(db, RATE_LIMIT_PATH, guildId);
    await setDoc(docRef, { milliseconds, action, updatedBy: userId, updatedAt: new Date() });
}

// --- Spam Detection Logic (Simplistic Example) ---
// Note: This is a placeholder for actual spam/scam detection.
function isSpam(content) {
    // 非常に単純なスパム判定: リンクが含まれており、かつ大文字が多い場合
    const hasLink = content.includes('http') || content.includes('www.');
    const upperCaseRatio = (content.match(/[A-Z]/g) || []).length / content.length;
    return hasLink && upperCaseRatio > 0.5;
}

// ユーザーメッセージ履歴（ローカルメモリ）
const userMessageHistory = new Map(); // Map<guildId, Map<userId, messageContent[]>>

// --- Event Handlers ---

client.once('ready', async () => {
    // Botの起動時にスラッシュコマンドを登録
    if (client.user) {
        await registerCommands();
        console.log(`Botが起動しました | ユーザー名: ${client.user.tag}`);
    } else {
        console.error("Bot user object is null on ready.");
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName, guildId, options, channel, member } = interaction;

    // 管理者権限チェック (メッセージ管理権限を持っているか)
    if (!member.permissions.has('ManageMessages')) {
        return interaction.reply({ content: '❌ **権限エラー:** このコマンドを使用するには「メッセージの管理」権限が必要です。', ephemeral: true });
    }

    try {
        await interaction.deferReply({ ephemeral: true });

        // --- /set-spam-threshold ---
        if (commandName === 'set-spam-threshold') {
            const threshold = options.getInteger('value');
            if (threshold < 1 || threshold > 10) {
                return interaction.editReply('❌ **エラー:** しきい値は1から10の間に設定してください。');
            }
            const settings = await getSpamSettings(guildId);
            await saveSpamSettings(guildId, threshold, settings.action);
            interaction.editReply(`✅ **スパムしきい値**を **${threshold} / 10** に設定しました。`);
        }

        // --- /set-spam-action ---
        else if (commandName === 'set-spam-action') {
            const action = options.getString('action');
            const settings = await getSpamSettings(guildId);
            await saveSpamSettings(guildId, settings.threshold, action);
            interaction.editReply(`✅ スパム検出時の**アクション**を **${action}** に設定しました。`);
        }

        // --- /set-rate-limit (新機能) ---
        else if (commandName === 'set-rate-limit') {
            const milliseconds = options.getInteger('milliseconds');
            const action = options.getString('limit_action');

            if (milliseconds < 100) {
                return interaction.editReply('❌ **エラー:** ミリ秒は最低でも100ms（0.1秒）以上に設定してください。高速すぎるとBotが不安定になります。');
            }

            await saveRateLimitSettings(guildId, milliseconds, action);
            interaction.editReply(`✅ **連投規制**の最小間隔を **${milliseconds} ミリ秒** に設定しました。アクション: **${action}**`);
        }


        // --- /show-spam-settings ---
        else if (commandName === 'show-spam-settings') {
            const spamSettings = await getSpamSettings(guildId);
            const rateLimitSettings = await getRateLimitSettings(guildId);

            let response = `**📝 現在のスパム対策設定**\n`;
            response += `---------------------------------\n`;
            response += `**① スパム判定のしきい値:** ${spamSettings.threshold} / 10\n`;
            response += `   * (直近10メッセージ中、これ以上のスパム検出でアクション)\n`;
            response += `**② スパム検出時のアクション:** **${spamSettings.action.toUpperCase()}**\n`;
            response += `\n`;
            response += `**⚡ 連投規制 (レートリミット)**\n`;
            response += `---------------------------------\n`;
            response += `**③ 最小投稿間隔:** **${rateLimitSettings.milliseconds} ミリ秒**\n`;
            response += `   * (0に設定されている場合、連投規制は無効です)\n`;
            response += `**④ 規制時のアクション:** **${rateLimitSettings.action.toUpperCase()}**\n`;

            interaction.editReply(response);
        }

        // --- /message-delete ---
        else if (commandName === 'message-delete') {
            const count = options.getInteger('count');
            const maxDelete = 1000;
            const batchSize = 100;
            
            if (count < 1 || count > maxDelete) {
                return interaction.editReply(`❌ **エラー:** 削除できるメッセージの数は1から${maxDelete}までです。`);
            }

            try {
                let totalDeleted = 0;
                let messagesRemaining = count;
                let lastMessageId = interaction.id; // コマンドメッセージより前のメッセージから取得を開始

                while (messagesRemaining > 0) {
                    const fetchLimit = Math.min(batchSize, messagesRemaining);
                    
                    // メッセージを取得（最大100件）
                    const fetched = await channel.messages.fetch({ 
                        limit: fetchLimit, 
                        before: lastMessageId 
                    });

                    if (fetched.size === 0) break; // もうメッセージがない場合、ループを終了

                    // 一括削除を実行
                    // filterOutOlder: true を設定しているため、14日以上前のメッセージは自動で除外される
                    const deleted = await channel.bulkDelete(fetched, true);
                    
                    totalDeleted += deleted.size;
                    messagesRemaining -= fetched.size;
                    lastMessageId = fetched.last().id;

                    // 14日以上前のメッセージしか残っておらず削除件数が0の場合、無限ループを防ぐために終了
                    // または、fetchしたメッセージのうち、一部しか削除されなかった場合（14日制限に達した可能性が高いため）終了
                    if (fetched.size > 0 && deleted.size < fetched.size) {
                        break;
                    }
                }
                
                // 応答メッセージを送信
                interaction.editReply(`✅ **成功:** 直近のメッセージ **${totalDeleted} 件** (最大${maxDelete}件まで) を削除しました。\n*注: Discordの制限により、削除対象は過去14日以内のメッセージに限られます。*`);
                
            } catch (error) {
                console.error('メッセージ削除エラー:', error);
                // エラー応答はEphemeralのまま
                await interaction.editReply({ content: '❌ **エラー:** メッセージの削除に失敗しました。（Botに「メッセージの管理」権限があるか、API制限に達していないか確認してください）', ephemeral: true });
            }
        }

    } catch (error) {
        console.error('Interaction Error:', error);
        if (!interaction.deferred || interaction.ephemeral) {
             interaction.reply({ content: '❌ **エラー:** コマンドの実行中に問題が発生しました。権限とログを確認してください。', ephemeral: true }).catch(e => console.error("Error replying to interaction:", e));
        } else {
             interaction.editReply('❌ **エラー:** コマンドの実行中に問題が発生しました。権限とログを確認してください。').catch(e => console.error("Error editing interaction reply:", e));
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const userId = message.author.id;
    const content = message.content;
    const now = Date.now();
    let actionExecuted = false; // アクションが実行されたかどうかを追跡

    // 1. --- 連投規制 (レートリミット) チェック ---
    const rateLimitSettings = await getRateLimitSettings(guildId);
    const minInterval = rateLimitSettings.milliseconds;
    const rateAction = rateLimitSettings.action;
    
    if (minInterval > 0) {
        const lastTime = lastUserMessage.get(userId) || 0;
        if (now - lastTime < minInterval) {
            console.log(`Rate Limit triggered for ${message.author.tag}`);
            
            if (rateAction === 'delete') {
                await message.delete().catch(e => console.error('Delete message error (Rate Limit):', e));
                actionExecuted = true;
            } else if (rateAction === 'warn') {
                message.reply(`🚨 **警告:** ${minInterval}ms 未満の連続投稿を検出しました。間隔を空けてください。`).catch(e => console.error('Warn message error (Rate Limit):', e));
                actionExecuted = true;
            }
            // 規制が発動した場合、メッセージ履歴の更新は行わない（スパムと見なすため）
            // 処理を継続すると、スパム判定も同時に実行されてしまうため、ここで終了
            lastUserMessage.set(userId, now); // タイムアウト後もすぐに次の投稿を防ぐため時刻を更新
            return;
        }
        lastUserMessage.set(userId, now); // 規制が発動しなかった場合は時刻を更新
    }

    // 2. --- スパムしきい値チェック ---
    const spamSettings = await getSpamSettings(guildId);
    const threshold = spamSettings.threshold;
    const spamAction = spamSettings.action;

    if (!userMessageHistory.has(guildId)) {
        userMessageHistory.set(guildId, new Map());
    }
    const guildHistory = userMessageHistory.get(guildId);
    if (!guildHistory.has(userId)) {
        guildHistory.set(userId, []);
    }
    const history = guildHistory.get(userId);

    // 履歴にメッセージを追加 (最新10件を保持)
    history.push(content);
    if (history.length > 10) {
        history.shift();
    }
    guildHistory.set(userId, history); // 履歴を更新

    // スパムメッセージの数をカウント
    let spamCount = history.filter(isSpam).length;

    // しきい値を超えたかチェック
    if (spamCount >= threshold && history.length >= 10 && !actionExecuted) {
        console.log(`Spam Threshold triggered for ${message.author.tag}. Count: ${spamCount}`);
        
        // 過去10件のメッセージを取得して処理
        const messages = await message.channel.messages.fetch({ limit: 10 });
        const userMessages = messages.filter(m => m.author.id === userId);

        if (spamAction === 'delete') {
            await message.channel.bulkDelete(userMessages, true)
                .then(() => console.log(`Deleted ${userMessages.size} messages from ${message.author.tag}`))
                .catch(e => console.error('Bulk delete error (Spam Threshold):', e));

            // 削除後、ユーザーの履歴をクリア
            guildHistory.set(userId, []);
        } else if (spamAction === 'warn') {
            message.reply(`🚨 **警告:** 連続したスパム行為を検出しました (${spamCount}/10)。行為を停止してください。`)
                .catch(e => console.error('Warn message error (Spam Threshold):', e));
        }
    }
});

client.login(TOKEN).catch(err => {
    console.error("Bot Login Error (Check DISCORD_TOKEN and Intents):", err);
});
