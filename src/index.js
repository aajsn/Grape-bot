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
const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
// Firestoreクライアントを取得します
const db = admin.firestore(app);

// Firestoreのユーティリティ関数を簡略化します
const collection = db.collection.bind(db); 

// データベースのコレクション名
const SETTINGS_COLLECTION = 'spam_settings';
const DEFAULT_SETTINGS = {
    timeframe: 2000, // 2000ミリ秒 (2秒)
    limit: 5,        // 5回
    action: 'timeout'   // デフォルトのアクション 
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

    // ✅ 新しいスラッシュコマンド：/spam-config (サブコマンドグループを使用)
    const spamConfigCommand = new SlashCommandBuilder()
        .setName('spam-config')
        .setDescription('連投規制の設定を管理します。')
        // 管理者権限を持つユーザーのみデフォルトで許可
        .setDefaultMemberPermissions(0) 
        
        // 1. サブコマンドグループ: 'set' (設定変更)
        .addSubcommandGroup(group =>
            group.setName('set')
                 .setDescription('連投規制のルール（時間、回数、動作）を変更します。')
                 
                // サブコマンド: 'rate-limit' (時間と動作)
                .addSubcommand(subcommand =>
                    subcommand.setName('rate-limit')
                        .setDescription('規制時間(ms)とアクションを設定します。')
                        .addIntegerOption(option =>
                            option.setName('milliseconds')
                                .setDescription('規制時間 (ミリ秒) 例: 1500 (1.5秒)')
                                .setRequired(true))
                        .addStringOption(option =>
                            option.setName('action')
                                .setDescription('規制を超えた場合の動作')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'メッセージを削除 (delete)', value: 'delete' },
                                    { name: 'ユーザーをタイムアウト (timeout)', value: 'timeout' }
                                ))
                )
                
                // サブコマンド: 'limit-count' (回数)
                .addSubcommand(subcommand =>
                    subcommand.setName('limit-count')
                        .setDescription('連投と見なすメッセージの回数を設定します。')
                        .addIntegerOption(option =>
                            option.setName('count')
                                .setDescription('メッセージの最大送信回数 例: 5')
                                .setRequired(true))
                )
        )

        // 2. サブコマンド: 'show' (設定表示)
        .addSubcommand(subcommand =>
            subcommand.setName('show')
                .setDescription('現在の連投規制設定を表示します。')
        );


    await client.application.commands.set([
        spamConfigCommand // 新しい /spam-config のみを登録
    ]);
    console.log('スラッシュコマンドの登録が完了しました。');
});

/**
 * データベースから設定を読み込むか、デフォルト設定を返します。
 * @param {string} guildId 
 * @returns {Promise<object>}
 */
async function getSpamSettings(guildId) {
    try {
        const docRef = collection(SETTINGS_COLLECTION).doc(guildId);
        const docSnap = await docRef.get(); 

        if (docSnap.exists) {
            return docSnap.data();
        } else {
            await docRef.set(DEFAULT_SETTINGS); 
            return DEFAULT_SETTINGS;
        }
    } catch (error) {
        console.error("ERROR: Firestoreから設定の読み込み/保存に失敗しました。デフォルト設定を使用します。", error.message);
        return DEFAULT_SETTINGS; 
    }
}

/**
 * データベースに新しい設定を保存します。
 * @param {string} guildId 
 * @param {object} settings 
 */
async function saveSpamSettings(guildId, settings) {
    try {
        const docRef = collection(SETTINGS_COLLECTION).doc(guildId);
        await docRef.set(settings, { merge: true }); 
    } catch (error) {
        console.error("ERROR: Firestoreへの設定の保存に失敗しました。", error.message);
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
                    msg.delete().catch(err => console.error("メッセージ削除エラー (権限不足等):", err));
                }
            });
            message.channel.send(`🚨 **連投検知:** ${message.author} のメッセージが ${timeframe}ms 以内に ${limit} 回を超えたため削除しました。`).then(m => setTimeout(() => m.delete(), 5000));
        } else if (action === 'timeout') {
            // タイムアウトアクション
            const timeoutDuration = 60000; 
            message.member.timeout(timeoutDuration, '連投規制違反')
                .then(() => {
                    message.channel.send(`🚨 **連投検知:** ${message.author} を連投規制違反のため ${timeoutDuration / 1000}秒間タイムアウトしました。`).then(m => setTimeout(() => m.delete(), 5000));
                })
                .catch(err => console.error("タイムアウト処理エラー (権限不足等):", err));
        }

        // 規制が発動したら、履歴をリセットしてペナルティ後のメッセージを許可する
        userMessageHistory.set(userId, []);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    
    const { commandName } = interaction;
    const guildId = interaction.guild.id;
    
    // 常に権限チェックを行う
    if (!interaction.memberPermissions.has('Administrator')) {
        return interaction.reply({ content: 'このコマンドを実行するには管理者権限が必要です。', ephemeral: true });
    }
    
    // /spam-config コマンドの処理
    if (commandName === 'spam-config') {
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();
        let settings = await getSpamSettings(guildId);

        // --- 'set' グループの処理 ---
        if (subcommandGroup === 'set') {
            
            if (subcommand === 'rate-limit') {
                const milliseconds = interaction.options.getInteger('milliseconds');
                const limitAction = interaction.options.getString('action');

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
                
            } else if (subcommand === 'limit-count') {
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
            }

        // --- 'show' サブコマンドの処理 ---
        } else if (subcommand === 'show') {
            const displayTime = settings.timeframe < 1000
                ? `${settings.timeframe}ミリ秒`
                : `${(settings.timeframe / 1000).toFixed(1)}秒`;

            await interaction.reply({
                content: `## 🚨 現在の連投規制設定\n\n- **規制時間 (タイムフレーム):** ${displayTime}\n- **連投回数 (リミット):** ${settings.limit}回\n- **規制動作 (アクション):** ${settings.action}`,
                ephemeral: true
            });
        }
    }
});

// BotをDiscordにログインさせます
client.login(token);
