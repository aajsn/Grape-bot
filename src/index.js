// Discord Bot Main Script (index.js)
// 変更点: interactionCreateのtry/catchブロックを強化し、deferReplyを確実に行うように修正

// --- Import Modules ---
import { Client, GatewayIntentBits, Collection, REST, Routes, ChannelType, PermissionsBitField, EmbedBuilder } from 'discord.js';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc } from 'firebase/firestore';

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

// Firestoreのコレクションパス
const SPAM_SETTINGS_PATH = `artifacts/${appId}/public/data/spam_settings`;
const RATE_LIMIT_PATH = `artifacts/${appId}/public/data/rate_limits`;

// Botのトークンは環境変数から取得
const TOKEN = process.env.DISCORD_TOKEN;

// --- Bot Client Setup ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers, // メンバー情報を取得するため
    ],
});

client.commands = new Collection();
const cooldowns = new Collection();
const lastUserMessage = new Map(); // ユーザーごとの最後のメッセージ時刻を記録 (連投規制用)
const userMessageHistory = new Map(); // Map<guildId, Map<userId, messageContent[]>> (スパム閾値用)


// --- Firestore Functions ---

// スパム設定を取得 (デフォルト: 閾値5, アクション: warn)
async function getSpamSettings(guildId) {
    const docRef = doc(db, SPAM_SETTINGS_PATH, guildId);
    try {
        const docSnap = await getDoc(docRef);
        return docSnap.exists() ? docSnap.data() : { threshold: 5, action: 'warn' };
    } catch (e) {
        console.error("Error fetching spam settings:", e);
        return { threshold: 5, action: 'warn' };
    }
}

// レートリミット設定を取得 (デフォルト: 最小間隔0ms, アクション: warn)
async function getRateLimitSettings(guildId) {
    const docRef = doc(db, RATE_LIMIT_PATH, guildId);
    try {
        const docSnap = await getDoc(docRef);
        // デフォルト: 最小間隔なし (0ms), アクションは警告
        return docSnap.exists() ? docSnap.data() : { milliseconds: 0, action: 'warn' }; 
    } catch (e) {
        console.error("Error fetching rate limit settings:", e);
        return { milliseconds: 0, action: 'warn' };
    }
}

// スパム設定を保存
async function saveSpamSettings(guildId, threshold, action) {
    const docRef = doc(db, SPAM_SETTINGS_PATH, guildId);
    const userId = auth.currentUser?.uid || 'anonymous-user';
    await setDoc(docRef, { threshold, action, updatedBy: userId, updatedAt: new Date() });
}

// レートリミット設定を保存
async function saveRateLimitSettings(guildId, milliseconds, action) {
    const docRef = doc(db, RATE_LIMIT_PATH, guildId);
    const userId = auth.currentUser?.uid || 'anonymous-user';
    await setDoc(docRef, { milliseconds, action, updatedBy: userId, updatedAt: new Date() });
}

// --- Spam Detection Logic (Simplistic Example) ---
// 非常に単純なスパム判定: リンクが含まれており、かつ大文字が多い場合
function isSpam(content) {
    if (!content) return false;
    const hasLink = content.includes('http') || content.includes('www.');
    const upperCaseCount = (content.match(/[A-Z]/g) || []).length;
    // 全体の文字数の30%以上がリンクまたは大文字の場合をスパムと見なす
    return hasLink || (upperCaseCount / content.length > 0.3);
}

// --- Command Definition and Registration ---
const commands = [
    {
        name: 'set-spam-threshold',
        description: 'スパム判定のしきい値（直近10件中、何件以上でアクション）を設定します。',
        default_member_permissions: PermissionsBitField.Flags.ManageMessages.toString(),
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
        default_member_permissions: PermissionsBitField.Flags.ManageMessages.toString(),
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
        name: 'set-rate-limit',
        description: '連投規制のしきい値（ミリ秒単位）を設定します。',
        default_member_permissions: PermissionsBitField.Flags.ManageMessages.toString(),
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
        description: 'チャンネルの直近メッセージを**一括削除 (Purge)** します。', 
        default_member_permissions: PermissionsBitField.Flags.ManageMessages.toString(),
        options: [
            {
                name: 'count',
                type: 4, // Integer
                description: '削除するメッセージの数 (1-100)。', // Discordの制限により100件が実質上限
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
        if (!client.user?.id) throw new Error("Client user ID is not available.");
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

// --- Event Handlers ---

// Botの起動イベント (v14/v15ではclientReady、旧バージョンではready)
client.once('clientReady', handleReady);
client.once('ready', handleReady); // フォールバックとして ready も残す

async function handleReady() {
    // 既に起動済みかチェック (readyとclientReady両方が発火するのを防ぐ)
    if (client.isReady()) {
        if (client.user) {
            await registerCommands();
            console.log(`✅ Botが起動しました | ユーザー名: ${client.user.tag}`);
        } else {
            console.error("❌ Bot user object is null on ready.");
        }
        // readyイベントが二重に発火しないように、handlerを削除する
        client.off('ready', handleReady);
        client.off('clientReady', handleReady);
    }
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() || !interaction.guildId) return;

    const { commandName, guildId, options, channel, member } = interaction;
    const isEphemeral = !['message-delete', 'show-spam-settings'].includes(commandName);

    try {
        // 1. **最優先:** Discordの3秒ルールを満たすために、即座に deferReply を実行する
        // Firestoreアクセスや権限チェックの前に実行することで、タイムアウトを防ぐ
        await interaction.deferReply({ ephemeral: isEphemeral }); 
        
        // 2. 権限チェック (Botにメッセージ管理権限があるか)
        if (!member?.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
            return interaction.editReply('❌ **権限エラー:** このコマンドを使用するには「メッセージの管理」権限が必要です。');
        }
        
        // Bot自身の権限もチェック
        if (!interaction.guild?.members.me?.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
            return interaction.editReply('❌ **Bot権限エラー:** 私（Bot）に「メッセージの管理」権限がありません。ロールの設定を確認してください。');
        }


        // --- /set-spam-threshold ---
        if (commandName === 'set-spam-threshold') {
            const threshold = options.getInteger('value');
            if (threshold < 1 || threshold > 10) {
                return interaction.editReply('❌ **エラー:** しきい値は1から10の間に設定してください。');
            }
            const settings = await getSpamSettings(guildId);
            await saveSpamSettings(guildId, threshold, settings.action);
            interaction.editReply(`✅ **スパムしきい値**を **${threshold} / 10** に設定しました。\n*（直近10メッセージ中、これ以上のスパム検出でアクション）*`);
        }

        // --- /set-spam-action ---
        else if (commandName === 'set-spam-action') {
            const action = options.getString('action');
            const settings = await getSpamSettings(guildId);
            await saveSpamSettings(guildId, settings.threshold, action);
            interaction.editReply(`✅ スパム検出時の**アクション**を **${action.toUpperCase()}** に設定しました。`);
        }

        // --- /set-rate-limit ---
        else if (commandName === 'set-rate-limit') {
            const milliseconds = options.getInteger('milliseconds');
            const action = options.getString('limit_action');

            if (milliseconds < 0) {
                return interaction.editReply('❌ **エラー:** ミリ秒は0以上の値を設定してください。');
            }
            if (milliseconds < 300 && milliseconds !== 0) {
                await interaction.editReply(`⚠️ **注意:** ${milliseconds} ミリ秒はBotが不安定になる可能性があります。`);
            }
            
            await saveRateLimitSettings(guildId, milliseconds, action);
            interaction.editReply(`✅ **連投規制**の最小間隔を **${milliseconds} ミリ秒** に設定しました。アクション: **${action.toUpperCase()}**`);
        }

        // --- /show-spam-settings ---
        else if (commandName === 'show-spam-settings') {
            const spamSettings = await getSpamSettings(guildId);
            const rateLimitSettings = await getRateLimitSettings(guildId);
            
            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('📝 現在のスパム対策設定')
                .setDescription(`このサーバーにおける現在の設定を表示しています。`)
                .addFields(
                    { name: 'スパム判定のしきい値', value: `${spamSettings.threshold} / 10`, inline: true },
                    { name: 'スパム検出時のアクション', value: `**${spamSettings.action.toUpperCase()}**`, inline: true },
                    { name: '\u200B', value: '\u200B' }, // 空行
                    { name: '最小投稿間隔 (連投規制)', value: `${rateLimitSettings.milliseconds} ミリ秒`, inline: true },
                    { name: '規制時のアクション', value: `**${rateLimitSettings.action.toUpperCase()}**`, inline: true },
                )
                .setFooter({ text: '設定はFirebase Firestoreに保存されています' })
                .setTimestamp();

            interaction.editReply({ embeds: [embed] });
        }

        // --- /message-delete (Purge) ---
        else if (commandName === 'message-delete') {
            const count = options.getInteger('count');
            const userToPurge = options.getUser('user');
            
            if (count < 1 || count > 100) {
                return interaction.editReply({ content: `❌ **エラー:** 削除できるメッセージの数は1から100までです。`, ephemeral: true });
            }

            try {
                let fetched = await channel.messages.fetch({ 
                    limit: count, 
                    before: interaction.id 
                });

                if (userToPurge) {
                    fetched = fetched.filter(msg => msg.author.id === userToPurge.id);
                }

                const deletedMessages = await channel.bulkDelete(fetched, true);
                
                const logEmbed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('🗑️ メッセージ一括削除 (Purge) ログ')
                    .setDescription(`**${channel.name}** チャンネルでメッセージが削除されました。`)
                    .addFields(
                        { name: '実行者', value: interaction.user.tag, inline: true },
                        { name: '削除件数', value: `${deletedMessages.size}件`, inline: true },
                        { name: '対象ユーザー', value: userToPurge ? `<@${userToPurge.id}>` : '全員', inline: true },
                        { name: 'チャンネル', value: `<#${channel.id}>`, inline: true }
                    )
                    .setTimestamp();
                
                await interaction.editReply({ 
                    content: `✅ **一括削除 (Purge) 完了:** 過去14日以内のメッセージ **${deletedMessages.size} 件**を削除しました。`,
                    embeds: [logEmbed],
                    ephemeral: false 
                });

            } catch (error) {
                console.error('メッセージ削除エラー:', error);
                await interaction.editReply({ 
                    content: '❌ **エラー:** メッセージの削除に失敗しました。（Botに「メッセージの管理」権限と、適切なロールの階層があるか確認してください）', 
                    ephemeral: true 
                });
            }
        }

    } catch (error) {
        console.error('Interaction Processing Error (After Defer):', error);
        // deferReplyの後にエラーが発生した場合、editReplyでユーザーに通知する
        if (interaction.deferred || interaction.replied) {
             interaction.editReply('❌ **予期せぬエラー:** コマンドの処理中に問題が発生しました。ログを確認してください。').catch(e => console.error("Error editing interaction reply after failure:", e));
        } else {
             // 滅多に発生しないが、念のため
             interaction.reply({ content: '❌ **予期せぬエラー:** コマンドの処理中に問題が発生しました。', ephemeral: true }).catch(e => console.error("Error replying to interaction after failure:", e));
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild || message.system) return;

    const guildId = message.guild.id;
    const userId = message.author.id;
    const content = message.content;
    const now = Date.now();
    
    // Botにメッセージを削除する権限があるかチェック
    if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return;
    }

    // 1. --- 連投規制 (レートリミット) チェック ---
    const rateLimitSettings = await getRateLimitSettings(guildId);
    const minInterval = rateLimitSettings.milliseconds;
    const rateAction = rateLimitSettings.action;
    
    if (minInterval > 0) {
        const lastTime = lastUserMessage.get(userId) || 0;
        if (now - lastTime < minInterval) {
            console.log(`[RATE_LIMIT] 🚨 ${message.author.tag} が ${minInterval}ms 未満で連続投稿しました。`);
            
            if (rateAction === 'delete') {
                await message.delete().catch(e => console.error('Delete message error (Rate Limit):', e));
            } else if (rateAction === 'warn') {
                message.reply(`🚨 **警告:** ${minInterval}ms 未満の連続投稿を検出しました。間隔を空けてください。`)
                      .then(reply => setTimeout(() => reply.delete().catch(e => e), 5000))
                      .catch(e => console.error('Warn message error (Rate Limit):', e));
            }
            lastUserMessage.set(userId, now);
            return;
        }
    }
    lastUserMessage.set(userId, now);

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

    history.push(content);
    if (history.length > 10) {
        history.shift();
    }
    guildHistory.set(userId, history);

    let spamCount = history.filter(isSpam).length;

    if (spamCount >= threshold && history.length >= 10) {
        console.log(`[SPAM_THRESHOLD] ❌ ${message.author.tag} のスパム検出が ${spamCount}/${threshold} に達しました。`);
        
        if (spamAction === 'delete') {
            const messagesToDelete = await message.channel.messages.fetch({ limit: 10 })
                .then(msgs => msgs.filter(m => m.author.id === userId));

            if (messagesToDelete.size > 0) {
                await message.channel.bulkDelete(messagesToDelete, true)
                    .catch(e => console.error('Bulk delete error (Spam Threshold):', e));
            }
            guildHistory.set(userId, []);
        } else if (spamAction === 'warn') {
            message.reply(`🚨 **警告:** 連続したスパム行為を検出しました (${spamCount}/10)。行為を停止してください。`)
                  .then(reply => setTimeout(() => reply.delete().catch(e => e), 5000))
                  .catch(e => console.error('Warn message error (Spam Threshold):', e));
        }
    }
});

client.login(TOKEN).catch(err => {
    console.error("❌ Bot Login Error (Check DISCORD_TOKEN and Intents):", err);
});
