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
    // Discord Botの必須インテントを設定
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers // タイムアウト処理に必要
    ]
});

// Botが起動した時の処理
client.once('ready', async () => {
    console.log('Botが起動しました:', client.user.tag);

    // ✅ /spam-config コマンド
    const spamConfigCommand = new SlashCommandBuilder()
        .setName('spam-config')
        .setDescription('連投規制の設定を管理します。')
        // 管理者権限を持つユーザーのみデフォルトで許可
        .setDefaultMemberPermissions(0) 
        
        // 1. サブコマンド: 'set' (設定変更)
        .addSubcommand(subcommand =>
            subcommand.setName('set')
                 .setDescription('連投規制のルール（時間、回数、動作）を変更します。')
                 
                // オプション1: rate (時間)
                .addIntegerOption(option =>
                    option.setName('rate')
                        .setDescription('規制時間 (ミリ秒) - 例: 1500 (1.5秒)')
                        .setRequired(false)) 
                
                // オプション2: action (動作) - rateと同時に指定されることを想定
                .addStringOption(option =>
                    option.setName('action')
                        .setDescription('規制を超えた場合の動作 (rateと同時に指定)')
                        .setRequired(false) 
                        .addChoices(
                            { name: 'メッセージを削除 (delete)', value: 'delete' },
                            { name: 'ユーザーをタイムアウト (timeout)', value: 'timeout' }
                        ))
                
                // オプション3: limit (回数)
                .addIntegerOption(option =>
                    option.setName('limit')
                        .setDescription('メッセージの最大送信回数 - 例: 5')
                        .setRequired(false))
        )

        // 2. サブコマンド: 'show' (設定表示)
        .addSubcommand(subcommand =>
            subcommand.setName('show')
                .setDescription('現在の連投規制設定を表示します。')
        );


    await client.application.commands.set([
        spamConfigCommand
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
            // ドキュメントが存在しない場合はデフォルト設定を保存してから返します
            await docRef.set(DEFAULT_SETTINGS); 
            return DEFAULT_SETTINGS;
        }
    } catch (error) {
        // Firestoreエラー時はログを出力し、デフォルト設定を返してクラッシュを防止
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

    // メンバーオブジェクトがない場合は取得を試みる (タイムアウト処理のため)
    if (!message.member) {
        try {
            // 💡 メンバーインテントが有効でないと、このフェッチは失敗します
            message.member = await message.guild.members.fetch(message.author.id);
        } catch (e) {
            console.error("Failed to fetch guild member (Check SERVER MEMBERS INTENT):", e);
            return;
        }
    }

    const guildId = message.guild.id;
    const userId = message.author.id;
    const currentTimestamp = Date.now();

    // メッセージ受信時にFirestoreアクセスを極力回避
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
            if (message.member) {
                message.member.timeout(timeoutDuration, '連投規制違反')
                    .then(() => {
                        message.channel.send(`🚨 **連投検知:** ${message.author} を連投規制違反のため ${timeoutDuration / 1000}秒間タイムアウトしました。`).then(m => setTimeout(() => m.delete(), 5000));
                    })
                    .catch(err => console.error("タイムアウト処理エラー (権限不足等):", err));
            } else {
                 console.error("Member object missing, cannot execute timeout action.");
            }
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
        const subcommand = interaction.options.getSubcommand();
        
        // 🚨 コマンド応答の高速化: 3秒の制限を回避するため、先にdeferReplyで応答する
        await interaction.deferReply({ ephemeral: true });

        // 設定の読み込みはdeferReply後に行う
        let settings = await getSpamSettings(guildId);

        // --- 'set' サブコマンドの処理 ---
        if (subcommand === 'set') {
            const rate = interaction.options.getInteger('rate');
            const action = interaction.options.getString('action');
            const limit = interaction.options.getInteger('limit');
            
            let replyContent = '設定が更新されました:';
            let changed = false; 

            // ✅ 必須チェックとバリデーション (rate または limit のどちらか必須)
            if (rate === null && limit === null) {
                return interaction.editReply({ 
                    content: '設定を変更するには、**`rate` (規制時間) または `limit` (回数) の少なくとも一方**を指定する必要があります。'
                });
            }
            
            // 1. rate (規制時間) と action の処理
            if (rate !== null) {
                if (rate < 100) {
                    return interaction.editReply({ content: '規制時間 (ミリ秒) は最低100ms以上に設定してください。' });
                }
                
                settings.timeframe = rate;
                replyContent += `\n- **規制時間:** ${rate}ミリ秒 (${(rate / 1000).toFixed(2)}秒)`;
                changed = true;

                // actionが指定されていれば更新
                if (action !== null) {
                    settings.action = action;
                    replyContent += `\n- **規制動作:** ${action}`;
                } else {
                    replyContent += `\n- **規制動作:** (変更なし: ${settings.action})`;
                }
            } else if (action !== null) {
                 // rateが指定されていないのにactionだけ指定された場合は警告
                 replyContent += `\n- **警告:** \`action\` は \`rate\` と同時に指定してください。今回は \`rate\` が変更されないため、\`action\` の変更は適用されません。`;
            }

            // 2. limit (回数) の処理
            if (limit !== null) {
                if (limit < 2) {
                    return interaction.editReply({ content: '連投回数は最低2回以上に設定してください。' });
                }
                settings.limit = limit;
                replyContent += `\n- **連投回数:** ${limit}回`;
                changed = true;
            }
            
            // 変更があった場合のみDBに保存を試みる
            if (changed) {
                await saveSpamSettings(guildId, settings);
            }

            // 最終的な応答を送信
            await interaction.editReply({
                content: replyContent
            });

        // --- 'show' サブコマンドの処理 ---
        } else if (subcommand === 'show') {
            const displayTime = settings.timeframe < 1000
                ? `${settings.timeframe}ミリ秒`
                : `${(settings.timeframe / 1000).toFixed(1)}秒`;

            // 最終的な応答を送信
            await interaction.editReply({
                content: `## 🚨 現在の連投規制設定\n\n- **規制時間 (タイムフレーム):** ${displayTime}\n- **連投回数 (リミット):** ${settings.limit}回\n- **規制動作 (アクション):** ${settings.action}`
            });
        }
    }
});

// BotをDiscordにログインさせます
client.login(token);
