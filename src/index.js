// Discord.jsをCommonJS形式で読み込みます
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
// Firebase Admin SDKのコアモジュール全体をインポートします
const admin = require('firebase-admin');

// 環境変数を取得します
const token = process.env.DISCORD_TOKEN;
const firebaseServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

// Firestoreのサービスアカウント情報（JSON）を解析します
let serviceAccount;
try {
    // Renderから取得した一行JSONをパースします
    serviceAccount = JSON.parse(firebaseServiceAccount);
} catch (error) {
    console.error("Firebase Service Accountのパースに失敗しました。環境変数を確認してください。");
    // エラー詳細を出力し、起動を停止します
    console.error(error);
    process.exit(1); 
}

// Firebaseの初期化とFirestoreへの接続
// Renderの環境変数から読み込んだ鍵を使って初期化します
// Admin SDKのcredentialとfirestoreを取得します
const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
// Firestoreクライアントを取得します
const db = admin.firestore(app);

// Firestoreのユーティリティ関数を簡略化します
const doc = db.doc.bind(db);
const setDoc = (ref, data, options) => ref.set(data, options);
const getDoc = (ref) => ref.get();

// データベースのコレクション名
const SETTINGS_COLLECTION = 'spam_settings';
const DEFAULT_SETTINGS = {
    timeframe: 2000, // 2000ミリ秒 (2秒)
    limit: 5,        // 5回
    action: 'mute'   // デフォルトのアクション
};

// Discordクライアントの初期化
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Botが起動した時の処理
client.once('ready', async () => {
    console.log('Botが起動しました:', client.user.tag);

    // スラッシュコマンドの登録
    const setRateLimitCommand = new SlashCommandBuilder()
        .setName('set-rate-limit')
        .setDescription('連投規制の時間をミリ秒単位で設定します (例: 100ms, 1000ms)')
        .addIntegerOption(option =>
            option.setName('milliseconds')
                .setDescription('規制時間 (ミリ秒) 例: 100 (0.1秒)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('limit_action')
                .setDescription('規制を超えた場合の動作')
                .setRequired(true)
                .addChoices(
                    { name: 'メッセージを削除 (delete)', value: 'delete' },
                    { name: 'ユーザーをタイムアウト (timeout)', value: 'timeout' }
                ));

    const setLimitCountCommand = new SlashCommandBuilder()
        .setName('set-limit-count')
        .setDescription('連投と見なすメッセージの回数を設定します')
        .addIntegerOption(option =>
            option.setName('count')
                .setDescription('メッセージの最大送信回数 例: 5')
                .setRequired(true));

    const showSettingsCommand = new SlashCommandBuilder()
        .setName('show-spam-settings')
        .setDescription('現在の連投規制設定を表示します');

    await client.application.commands.set([
        setRateLimitCommand,
        setLimitCountCommand,
        showSettingsCommand
    ]);
    console.log('スラッシュコマンドを登録しました。');
});

/**
 * データベースから設定を読み込むか、デフォルト設定を返します。
 * @param {string} guildId 
 * @returns {Promise<object>}
 */
async function getSpamSettings(guildId) {
    try {
        const docRef = doc(SETTINGS_COLLECTION, guildId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists) {
            return docSnap.data();
        } else {
            // ドキュメントが存在しない場合はデフォルト設定を保存してから返します
            await setDoc(docRef, DEFAULT_SETTINGS);
            return DEFAULT_SETTINGS;
        }
    } catch (error) {
        console.error("Firestoreから設定の読み込み/保存に失敗しました。デフォルト設定を使用します。", error);
        return DEFAULT_SETTINGS; // DBエラー時もBotはクラッシュせず続行
    }
}

/**
 * データベースに新しい設定を保存します。
 * @param {string} guildId 
 * @param {object} settings 
 */
async function saveSpamSettings(guildId, settings) {
    try {
        const docRef = doc(SETTINGS_COLLECTION, guildId);
        await setDoc(docRef, settings, { merge: true });
    } catch (error) {
        console.error("Firestoreへの設定の保存に失敗しました。", error);
    }
}

// ユーザーごとのメッセージ履歴を保存するマップ
const userMessageHistory = new Map();

client.on('messageCreate', async message => {
    // Bot自身のメッセージやDMは無視
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const userId = message.author.id;
    const currentTimestamp = Date.now();

    // サーバーの設定を読み込み
    const settings = await getSpamSettings(guildId);
    const { timeframe, limit, action } = settings;

    // ユーザーの履歴を取得
    let history = userMessageHistory.get(userId) || [];

    // timeframe内に送信されたメッセージだけを残す
    history = history.filter(timestamp => currentTimestamp - timestamp < timeframe);

    // 今回のメッセージのタイムスタンプを追加
    history.push(currentTimestamp);
    userMessageHistory.set(userId, history);

    // 連投と見なされるかチェック
    if (history.length > limit) {
        // 規制アクションを実行
        console.log(`連投を検出: ユーザー ${message.author.tag} が ${timeframe}ms に ${history.length} 回送信しました。`);

        if (action === 'delete') {
            // メッセージ削除アクション
            const messagesToDelete = await message.channel.messages.fetch({ limit: history.length });
            messagesToDelete.forEach(msg => {
                if (msg.author.id === userId) {
                    msg.delete().catch(err => console.error("メッセージ削除エラー:", err));
                }
            });
            message.channel.send(`🚨 **連投検知:** ${message.author} のメッセージが ${timeframe}ms 以内に ${limit} 回を超えたため削除しました。`).then(m => setTimeout(() => m.delete(), 5000));
        } else if (action === 'timeout') {
            // タイムアウトアクション (discord.js v13以降で利用可能)
            // タイムアウトを1分間に設定
            const timeoutDuration = 60000; 
            message.member.timeout(timeoutDuration, '連投規制違反')
                .then(() => {
                    message.channel.send(`🚨 **連投検知:** ${message.author} を連投規制違反のため ${timeoutDuration / 1000}秒間タイムアウトしました。`).then(m => setTimeout(() => m.delete(), 5000));
                })
                .catch(err => console.error("タイムアウト処理エラー:", err));
        }

        // 規制が発動したら、履歴をリセットしてペナルティ後のメッセージを許可する
        userMessageHistory.set(userId, []);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    if (!interaction.memberPermissions.has('Administrator')) {
        return interaction.reply({ content: 'このコマンドを実行するには管理者権限が必要です。', ephemeral: true });
    }

    const { commandName } = interaction;
    const guildId = interaction.guild.id;
    let settings = await getSpamSettings(guildId);

    if (commandName === 'set-rate-limit') {
        const milliseconds = interaction.options.getInteger('milliseconds');
        const limitAction = interaction.options.getString('limit_action');

        if (milliseconds < 100) {
            return interaction.reply({ content: '規制時間 (ミリ秒) は最低100ms以上に設定してください。', ephemeral: true });
        }

        settings.timeframe = milliseconds;
        settings.action = limitAction;
        await saveSpamSettings(guildId, settings);

        await interaction.reply({
            content: `連投規制時間を **${milliseconds}ミリ秒 (${(milliseconds / 1000).toFixed(2)}秒)** に、規制動作を **${limitAction}** に設定しました。`,
            ephemeral: true
        });

    } else if (commandName === 'set-limit-count') {
        const count = interaction.options.getInteger('count');

        if (count < 2) {
            return interaction.reply({ content: '連投回数は最低2回以上に設定してください。', ephemeral: true });
        }

        settings.limit = count;
        await saveSpamSettings(guildId, settings);

        await interaction.reply({
            content: `連投と見なすメッセージ回数を **${count}回** に設定しました。`,
            ephemeral: true
        });

    } else if (commandName === 'show-spam-settings') {
        const displayTime = settings.timeframe < 1000
            ? `${settings.timeframe}ミリ秒`
            : `${(settings.timeframe / 1000).toFixed(1)}秒`;

        await interaction.reply({
            content: `## 🚨 現在の連投規制設定\n\n- **規制時間 (タイムフレーム):** ${displayTime}\n- **連投回数 (リミット):** ${settings.limit}回\n- **規制動作 (アクション):** ${settings.action}`,
            ephemeral: true
        });
    }
});

// BotをDiscordにログインさせます
client.login(token);
