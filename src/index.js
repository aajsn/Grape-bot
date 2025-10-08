// Discord.jsをCommonJS形式で読み込みます
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
// Firebase Admin SDKのコアモジュール全体をインポートします
const admin = require('firebase-admin');
// ★★★ Replit/Glitch対応のために http モジュールをインポート ★★★
const http = require('http');

// 環境変数を取得します
const token = process.env.DISCORD_TOKEN;
const firebaseServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

// Firestoreのサービスアカウント情報（JSON）を解析します
let serviceAccount;
try {
    // 環境変数から取得した一行JSONをパースします
    serviceAccount = JSON.parse(firebaseServiceAccount);
} catch (error) {
    console.error("Firebase Service Accountのパースに失敗しました。環境変数を確認してください。");
    console.error(error);
    process.exit(1); 
}

// Firebaseの初期化とFirestoreへの接続
const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore(app);
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
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers // タイムアウト処理に必要
    ]
});

// ********************************************
// ★★★ [重要] 未処理の例外をキャッチしてクラッシュを防ぐロジックの追加 ★★★
// ********************************************
// プログラムのどこかで予期せぬエラーが発生しても、Bot全体が落ちるのを防ぎます
process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection (予期せぬエラー):', error);
    // Render/ReplitでBotがクラッシュするのを防ぎ、処理を続行します
});
process.on('uncaughtException', error => {
    console.error('Uncaught Exception (捕捉されていない例外):', error);
    // Botがクラッシュするのを防ぎ、処理を続行します
});
// ********************************************

// Botが起動した時の処理
client.once('ready', async () => {
    console.log('Botが起動しました:', client.user.tag);

    // /spam-config コマンドの定義
    const spamConfigCommand = new SlashCommandBuilder()
        .setName('spam-config')
        .setDescription('連投規制の設定を管理します。')
        .setDefaultMemberPermissions(0) // デフォルトで管理者権限が必要
        .addSubcommand(subcommand =>
            subcommand.setName('set')
                 .setDescription('連投規制のルール（時間、回数、動作）を変更します。')
                .addIntegerOption(option =>
                    option.setName('rate')
                        .setDescription('規制時間 (ミリ秒) - 例: 1500 (1.5秒)')
                        .setRequired(false)) 
                .addStringOption(option =>
                    option.setName('action')
                        .setDescription('規制を超えた場合の動作 (rateと同時に指定)')
                        .setRequired(false) 
                        .addChoices(
                            { name: 'メッセージを削除 (delete)', value: 'delete' },
                            { name: 'ユーザーをタイムアウト (timeout)', value: 'timeout' }
                        ))
                .addIntegerOption(option =>
                    option.setName('limit')
                        .setDescription('メッセージの最大送信回数 - 例: 5')
                        .setRequired(false))
        )
        .addSubcommand(subcommand =>
            subcommand.setName('show')
                .setDescription('現在の連投規制設定を表示します。')
        );


    try {
        await client.application.commands.set([
            spamConfigCommand
        ]);
        console.log('スラッシュコマンドの登録が完了しました。');
    } catch (e) {
        console.error('ERROR: スラッシュコマンドの登録に失敗しました。', e);
    }
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
            // ドキュメントが存在しない場合はデフォルト設定を保存してから返す
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
    // messageCreateイベント全体をtry-catchで囲み、Botのクラッシュを防ぐ
    try {
        // Bot自身のメッセージやDMは無視
        if (message.author.bot || !message.guild) return;

        // メンバーオブジェクトがない場合は取得を試みる (タイムアウト処理のため)
        if (!message.member) {
            try {
                message.member = await message.guild.members.fetch(message.author.id);
            } catch (e) {
                console.error("Failed to fetch guild member (Check SERVER MEMBERS INTENT):", e);
                return;
            }
        }

        const guildId = message.guild.id;
        const userId = message.author.id;
        const currentTimestamp = Date.now();

        const settings = await getSpamSettings(guildId);
        const { timeframe, limit, action } = settings;

        // ユーザーの履歴を取得
        let history = userMessageHistory.get(userId) || [];
        history = history.filter(timestamp => currentTimestamp - timestamp < timeframe);
        history.push(currentTimestamp);
        userMessageHistory.set(userId, history);

        // 連投と見なされるかチェック
        if (history.length > limit) {
            console.log(`連投を検出: ユーザー ${message.author.tag} が ${timeframe}ms に ${history.length} 回送信しました。`);

            if (action === 'delete') {
                // メッセージ削除アクション
                const messagesToDelete = await message.channel.messages.fetch({ limit: history.length });
                messagesToDelete.forEach(msg => {
                    // 確実に連投ユーザーのメッセージのみを削除し、エラーを無視
                    if (msg.author.id === userId) {
                        msg.delete().catch(err => console.error("メッセージ削除エラー (権限不足等):", err));
                    }
                });
                message.channel.send(`🚨 **連投検知:** ${message.author} のメッセージが ${timeframe}ms 以内に ${limit} 回を超えたため削除しました。`).then(m => setTimeout(() => m.delete(), 5000));
            } else if (action === 'timeout') {
                // タイムアウトアクション
                const timeoutDuration = 60000; // 60秒
                if (message.member) {
                    // ★タイムアウト処理をtry-catchで囲み、プログラム全体が落ちるのを防ぐ★
                    try {
                        await message.member.timeout(timeoutDuration, '連投規制違反');
                        message.channel.send(`🚨 **連投検知:** ${message.author} を連投規制違反のため ${timeoutDuration / 1000}秒間タイムアウトしました。`).then(m => setTimeout(() => m.delete(), 5000));
                    } catch (err) {
                        // 権限不足などでタイムアウトに失敗した場合
                        console.error("CRITICAL: タイムアウト処理エラー。Botがサーバーより権限が低い可能性があります。", err);
                        // タイムアウト失敗時はメッセージ削除にフォールバックしてログを出す
                        message.channel.send(`🚨 **連投検知:** ${message.author} のタイムアウトに失敗しました。（Botの権限不足）代わりにメッセージを削除します。`).then(m => setTimeout(() => m.delete(), 5000));
                    }
                } else {
                     console.error("Member object missing, cannot execute timeout action.");
                }
            }

            // 規制が発動したら、履歴をリセットしてペナルティ後のメッセージを許可する
            userMessageHistory.set(userId, []);
        }
    } catch (e) {
        // messageCreateイベント全体のエラーをキャッチしてBotのクラッシュを防ぐ
        console.error("FATAL: messageCreateイベントで予期せぬエラーが発生しました。Botは続行します。", e);
    }
});

client.on('interactionCreate', async interaction => {
    // interactionCreate全体をtry-catchで囲み、クラッシュを防ぐ
    try {
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
            // deferReplyで処理中の応答を保証
            await interaction.deferReply({ ephemeral: true });

            let settings = await getSpamSettings(guildId);

            if (subcommand === 'set') {
                const rate = interaction.options.getInteger('rate');
                const action = interaction.options.getString('action');
                const limit = interaction.options.getInteger('limit');
                
                let replyContent = '設定が更新されました:';
                let changed = false; 

                if (rate === null && limit === null) {
                    return interaction.editReply({ 
                        content: '設定を変更するには、**`rate` (規制時間) または `limit` (回数) の少なくとも一方**を指定する必要があります。'
                    });
                }
                
                if (rate !== null) {
                    if (rate < 100) {
                        return interaction.editReply({ content: '規制時間 (ミリ秒) は最低100ms以上に設定してください。' });
                    }
                    
                    settings.timeframe = rate;
                    replyContent += `\n- **規制時間:** ${rate}ミリ秒 (${(rate / 1000).toFixed(2)}秒)`;
                    changed = true;

                    if (action !== null) {
                        settings.action = action;
                        replyContent += `\n- **規制動作:** ${action}`;
                    } else {
                        replyContent += `\n- **規制動作:** (変更なし: ${settings.action})`;
                    }
                } else if (action !== null) {
                     replyContent += `\n- **警告:** \`action\` は \`rate\` と同時に指定してください。今回は \`rate\` が変更されないため、\`action\` の変更は適用されません。`;
                }

                if (limit !== null) {
                    if (limit < 2) {
                        return interaction.editReply({ content: '連投回数は最低2回以上に設定してください。' });
                    }
                    settings.limit = limit;
                    replyContent += `\n- **連投回数:** ${limit}回`;
                    changed = true;
                }
                
                if (changed) {
                    await saveSpamSettings(guildId, settings);
                }

                await interaction.editReply({
                    content: replyContent
                });

            } else if (subcommand === 'show') {
                const displayTime = settings.timeframe < 1000
                    ? `${settings.timeframe}ミリ秒`
                    : `${(settings.timeframe / 1000).toFixed(1)}秒`;

                await interaction.editReply({
                    content: `## 🚨 現在の連投規制設定\n\n- **規制時間 (タイムフレーム):** ${displayTime}\n- **連投回数 (リミット):** ${settings.limit}回\n- **規制動作 (アクション):** ${settings.action}`
                });
            }
        }
    } catch (e) {
         // interactionCreateイベント全体のエラーをキャッチ
         console.error("FATAL: interactionCreateイベントで予期せぬエラーが発生しました。Botは続行します。", e);
         // 応答を試みる（既にdeferReply済みの場合、editReplyでエラーを通知）
         if (interaction.deferred || interaction.replied) {
             interaction.editReply({ content: 'コマンド実行中に予期せぬエラーが発生しました。', ephemeral: true }).catch(() => {});
         } else {
             interaction.reply({ content: 'コマンド実行中に予期せぬエラーが発生しました。', ephemeral: true }).catch(() => {});
         }
    }
});

// ********************************************
// ★★★ Render/Replit対応のための追記（Botがスリープするのを防ぐ） ★★★
// ********************************************
const server = http.createServer((req, res) => {
    // 外部からのアクセスに対してHTTPステータス200を返し、Botが稼働中であることを通知します
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running\n');
});

// BotをDiscordにログインさせ、成功後にWebサーバーを起動
client.login(token)
    .then(() => {
        const port = process.env.PORT || 3000;
        server.listen(port, () => {
            console.log(`Replit Web Server is listening on port ${port}`); 
        });
    })
    .catch(error => {
        console.error("Discord Login Error: Discord APIへの接続に失敗しました。", error);
        process.exit(1); // ログイン失敗時はBotを終了し、Renderに再起動させます
    });
// ********************************************
