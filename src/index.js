// Discord.jsをCommonJS形式で読み込みます
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
// Firebase Admin SDKのコアモジュール全体をインポートします
const admin = require('firebase-admin');
// ★★★ Render/Replit対応のために http モジュールをインポート ★★★
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
process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection (予期せぬエラー):', error);
});
process.on('uncaughtException', error => {
    console.error('Uncaught Exception (捕捉されていない例外):', error);
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

    // /purge コマンドの定義
    const purgeCommand = new SlashCommandBuilder()
        .setName('purge')
        .setDescription('指定された数のメッセージを一括削除します（最大99件）。')
        .setDefaultMemberPermissions(0) // デフォルトで管理者権限が必要
        .addIntegerOption(option =>
            option.setName('count')
                .setDescription('削除するメッセージの数 (2～99)')
                .setRequired(true)
                .setMinValue(2)
                .setMaxValue(99)
        )
        .addUserOption(option =>
            option.setName('user')
                .setDescription('指定したユーザーのメッセージのみ削除します。')
                .setRequired(false)
        );

    try {
        await client.application.commands.set([
            spamConfigCommand,
            purgeCommand
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
    try {
        if (message.author.bot || !message.guild) return;

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

        let history = userMessageHistory.get(userId) || [];
        history = history.filter(timestamp => currentTimestamp - timestamp < timeframe);
        history.push(currentTimestamp);
        userMessageHistory.set(userId, history);

        if (history.length > limit) {
            console.log(`連投を検出: ユーザー ${message.author.tag} が ${timeframe}ms に ${history.length} 回送信しました。`);

            if (action === 'delete') {
                const messagesToDelete = await message.channel.messages.fetch({ limit: history.length });
                messagesToDelete.forEach(msg => {
                    if (msg.author.id === userId) {
                        msg.delete().catch(err => console.error("メッセージ削除エラー (権限不足等):", err));
                    }
                });
                message.channel.send(`🚨 **連投検知:** ${message.author} のメッセージが ${timeframe}ms 以内に ${limit} 回を超えたため削除しました。`).then(m => setTimeout(() => m.delete(), 5000));
            } else if (action === 'timeout') {
                const timeoutDuration = 60000; // 60秒
                if (message.member) {
                    try {
                        await message.member.timeout(timeoutDuration, '連投規制違反');
                        message.channel.send(`🚨 **連投検知:** ${message.author} を連投規制違反のため ${timeoutDuration / 1000}秒間タイムアウトしました。`).then(m => setTimeout(() => m.delete(), 5000));
                    } catch (err) {
                        console.error("CRITICAL: タイムアウト処理エラー。Botがサーバーより権限が低い可能性があります。", err);
                        message.channel.send(`🚨 **連投検知:** ${message.author} のタイムアウトに失敗しました。（Botの権限不足）代わりにメッセージを削除します。`).then(m => setTimeout(() => m.delete(), 5000));
                    }
                } else {
                     console.error("Member object missing, cannot execute timeout action.");
                }
            }
            userMessageHistory.set(userId, []);
        }
    } catch (e) {
        console.error("FATAL: messageCreateイベントで予期せぬエラーが発生しました。Botは続行します。", e);
    }
});

client.on('interactionCreate', async interaction => {
    try {
        if (!interaction.isCommand()) return;
        
        const { commandName } = interaction;
        
        // 常に権限チェックを行う
        if (!interaction.memberPermissions.has('Administrator')) {
            // ★★★ [変更] 権限エラー応答はEphemeralのままにしておく (セキュリティ上の理由) ★★★
            return interaction.reply({ content: 'このコマンドを実行するには管理者権限が必要です。', ephemeral: true });
        }
        
        // deferReplyで処理中の応答を保証。ここではEphemeralを外す！
        // ★★★ [変更] ephemeral: false を明示的に指定しない（デフォルトの動作にする） ★★★
        await interaction.deferReply(); 

        // /spam-config コマンドの処理
        if (commandName === 'spam-config') {
            const subcommand = interaction.options.getSubcommand();
            const guildId = interaction.guild.id;
            let settings = await getSpamSettings(guildId);

            if (subcommand === 'set') {
                const rate = interaction.options.getInteger('rate');
                const action = interaction.options.getString('action');
                const limit = interaction.options.getInteger('limit');
                
                let replyContent = '設定が更新されました:';
                let changed = false; 

                // ... (spam-config set のロジックは省略 - 変更なし)
                
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

                // ★★★ [変更] setコマンドの結果はEphemeralのままにしておく (設定変更は管理者のみに関係するため) ★★★
                await interaction.editReply({
                    content: replyContent
                });

            } else if (subcommand === 'show') {
                const displayTime = settings.timeframe < 1000
                    ? `${settings.timeframe}ミリ秒`
                    : `${(settings.timeframe / 1000).toFixed(1)}秒`;

                // ★★★ [変更] showコマンドの結果は全員に見えるようにする ★★★
                await interaction.editReply({
                    content: `## 🚨 現在の連投規制設定\n\n- **規制時間 (タイムフレーム):** ${displayTime}\n- **連投回数 (リミット):** ${settings.limit}回\n- **規制動作 (アクション):** ${settings.action}`,
                    ephemeral: false // 公開応答にする
                });
            }
        
        // /purge コマンドの処理 
        } else if (commandName === 'purge') {
            const count = interaction.options.getInteger('count');
            const userToPurge = interaction.options.getUser('user');
            const targetUserId = userToPurge ? userToPurge.id : null;
            
            if (count < 2 || count > 99) {
                // エラー応答はEphemeralのまま
                return interaction.editReply({ content: '削除できるメッセージ数は2件から99件の間です。', ephemeral: true });
            }

            try {
                // 削除対象のメッセージを取得
                const fetched = await interaction.channel.messages.fetch({ limit: count });
                
                let messagesToDelete = fetched;

                // ユーザーが指定された場合、そのユーザーのメッセージにフィルタリング
                if (targetUserId) {
                    messagesToDelete = fetched.filter(msg => msg.author.id === targetUserId);
                }

                // 一括削除の実行 (14日以上前のメッセージは自動で無視される)
                const deleted = await interaction.channel.bulkDelete(messagesToDelete, true);
                
                const deleteCount = deleted.size;
                
                // ★★★ ログEmbedを作成 ★★★
                const logEmbed = new EmbedBuilder()
                    .setColor(0xFF0000) // 赤色
                    .setTitle('🗑️ メッセージ一括削除 (Purge) ログ')
                    .setDescription(`**${interaction.channel.name}** チャンネルでメッセージが削除されました。`)
                    .addFields(
                        { name: '実行者', value: interaction.user.tag, inline: true },
                        { name: '削除件数', value: `${deleteCount}件`, inline: true },
                        { name: '対象ユーザー', value: targetUserId ? `<@${targetUserId}>` : '全員', inline: true },
                        { name: '削除されたチャンネル', value: `<#${interaction.channel.id}>`, inline: true },
                        { name: 'コマンド実行日時', value: new Date().toISOString(), inline: false }
                    )
                    .setTimestamp();
                
                
                // ★★★ [変更] 全員に見える公開応答にする ★★★
                await interaction.editReply({ 
                    content: `✅ 削除が完了しました。**${deleteCount}件**のメッセージを削除しました。`,
                    embeds: [logEmbed],
                    ephemeral: false // 公開応答にする
                });

                // 5秒後に確認メッセージを自動で削除 (Wick風の動作)
                setTimeout(() => {
                    // Bot自身が送った応答メッセージを削除
                    interaction.deleteReply().catch(err => console.error("応答メッセージの削除に失敗しました。", err));
                }, 5000);

            } catch (error) {
                console.error('メッセージ削除エラー:', error);
                // エラー応答はEphemeralのまま
                await interaction.editReply({ content: 'メッセージの削除に失敗しました。（Botに「メッセージの管理」権限があるか確認してください）', ephemeral: true });
            }
        }
    } catch (e) {
         console.error("FATAL: interactionCreateイベントで予期せぬエラーが発生しました。Botは続行します。", e);
         if (interaction.deferred || interaction.replied) {
             // エラー応答はEphemeralのまま
             interaction.editReply({ content: 'コマンド実行中に予期せぬエラーが発生しました。', ephemeral: true }).catch(() => {});
         } else {
             // エラー応答はEphemeralのまま
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
