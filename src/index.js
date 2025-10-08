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
        description: 'チャンネルの直近メッセージを**一括削除 (Purge)** します。', // Purge対応
        options: [
            {
                name: 'count',
                type: 4, // Integer
                description: '削除するメッセージの数 (1-1000)。',
                required: true,
            },
            {
                name: 'user',
                type: 6, // User
                description: '特定のユーザーのメッセージのみを削除します。',
                required: false,
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
        // デフォルトで公開応答（ephemeral: false）を設定
        let isEphemeral = true; // デフォルトはEphemeral
        if (commandName === 'message-delete' || commandName === 'show-spam-settings') {
            isEphemeral = false; // これらのコマンドは公開にする
        }
        
        // deferReplyを先に実行
        await interaction.deferReply({ ephemeral: isEphemeral }); 

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

            // ephemeral: false は deferReplyで既に設定されている
            interaction.editReply(response);
        }

        // --- /message-delete ---
        else if (commandName === 'message-delete') {
            const count = options.getInteger('count');
            const userToPurge = options.getUser('user');
            const targetUserId = userToPurge ? userToPurge.id : null;
            
            const maxDelete = 1000;
            const batchSize = 100;
            
            if (count < 1 || count > maxDelete) {
                // エラー応答はEphemeralのままにしておく
                return interaction.editReply({ content: `❌ **エラー:** 削除できるメッセージの数は1から${maxDelete}までです。`, ephemeral: true });
            }

            try {
                let totalDeleted = 0;
                let messagesRemaining = count;
                let lastMessageId = interaction.id; // コマンドメッセージより前のメッセージから取得を開始

                // --- 削除メッセージ収集ループ ---
                const messagesToBulkDelete = []; // 一括削除対象のメッセージIDリスト

                while (messagesRemaining > 0) {
                    const fetchLimit = Math.min(batchSize, messagesRemaining);
                    
                    const fetched = await channel.messages.fetch({ 
                        limit: fetchLimit, 
                        before: lastMessageId 
                    });

                    if (fetched.size === 0) break; 

                    let currentBatch = fetched;

                    // ユーザー指定がある場合、フィルタリング
                    if (targetUserId) {
                        currentBatch = fetched.filter(msg => msg.author.id === targetUserId);
                    }
                    
                    // 削除対象のIDをリストに追加
                    currentBatch.forEach(msg => messagesToBulkDelete.push(msg.id));

                    messagesRemaining -= fetched.size;
                    lastMessageId = fetched.last().id;

                    // 14日以上前のメッセージしか残っておらず、次のループが期待できない場合は終了
                    if (fetched.size < fetchLimit) break;
                }
                
                // --- 実際の削除 ---
                const deletedMessages = await channel.bulkDelete(messagesToBulkDelete, true);
                
                // --- ログEmbedの作成 ---
                const logEmbed = {
                    color: 0xFF0000, 
                    title: '🗑️ メッセージ一括削除 (Purge) ログ', // Purge対応
                    description: `**${channel.name}** チャンネルでメッセージが削除されました。`,
                    fields: [
                        { name: '実行者', value: interaction.user.tag, inline: true },
                        { name: '削除件数', value: `${deletedMessages.size}件`, inline: true }, // 実際に削除された件数
                        { name: '対象ユーザー', value: targetUserId ? `<@${targetUserId}>` : '全員', inline: true },
                        { name: '削除されたチャンネル', value: `<#${channel.id}>`, inline: true },
                        { name: 'コマンド実行日時', value: new Date().toISOString(), inline: false }
                    ],
                    timestamp: new Date().toISOString(),
                };
                
                // --- 応答メッセージの公開（永続化） ---
                await interaction.editReply({ 
                    content: `✅ **一括削除 (Purge) 完了:** 過去14日以内のメッセージ **${deletedMessages.size} 件**を削除しました。 (指定件
