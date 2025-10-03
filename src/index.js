// 必要なライブラリを読み込みます
const { 
    Client, GatewayIntentBits, REST, Routes, 
    PermissionsBitField, SlashCommandStringOption,
    ChannelType
} = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
// 設定保存のためにファイルシステムモジュールを使用します
const fs = require('fs').promises; 

// Botが何のイベントを監視するかを設定します
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,           // サーバー関連
        GatewayIntentBits.GuildMessages,    // メッセージの受信
        GatewayIntentBits.MessageContent,   // メッセージ内容の読み取り
        GatewayIntentBits.GuildMembers      // メンバー情報の取得
    ] 
});

// ===========================================
// グローバルなデータストアと設定 (スパム対策用)
// ===========================================

// スパム設定のデフォルト値
const DEFAULT_SETTINGS = {
    limit: 5,               // 許容メッセージ数 (N)
    duration: 10,           // 監視時間 (秒)
    timeoutDuration: 300    // タイムアウト時間 (秒, 5分)
};

// 監視ログ
const spamLog = {}; 
const CONFIG_FILE = 'spam_config.json'; 

/** スパム設定の取得 */
async function getSpamSettings(guildId) {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        const configs = JSON.parse(data);
        return configs[guildId] || DEFAULT_SETTINGS;
    } catch (error) {
        return DEFAULT_SETTINGS;
    }
}

/** スパム設定の保存 */
async function saveSpamSettings(guildId, settings) {
    let configs = {};
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        configs = JSON.parse(data);
    } catch (error) {
        // 無視
    }
    configs[guildId] = settings;
    await fs.writeFile(CONFIG_FILE, JSON.stringify(configs, null, 2), 'utf8');
}

/** ユーザーのスパムログをメモリ上で初期化 */
function initializeUserLog(guildId, userId) {
    if (!spamLog[guildId]) {
        spamLog[guildId] = {};
    }
    if (!spamLog[guildId][userId]) {
        spamLog[guildId][userId] = { messages: [] };
    }
}

// ===========================================
// Bot起動時の処理
// ===========================================

client.once('ready', async () => {
    console.log(`Botが起動しました！ユーザー名: ${client.user.tag}`);
    await registerSlashCommands();
});

// ===========================================
// スラッシュコマンド定義と登録
// ===========================================

// 削除範囲のオプション (1-99の整数 または 'all') を作成
const deleteRangeOption = new SlashCommandStringOption()
    .setName('range')
    .setDescription('削除するメッセージ数 (1-99) または "all" を指定')
    .setRequired(true)
    .addChoices(
        { name: 'そのユーザーのメッセージをすべて削除', value: 'all' },
        { name: '直近のメッセージ10件', value: '10' },
        { name: '直近のメッセージ50件', value: '50' }
        // ユーザーは任意の数字 (文字列として) も入力できます
    );

// スラッシュコマンド一覧
const commands = [
    // 1. スパム設定コマンド
    new SlashCommandBuilder()
        .setName('set-spam-settings')
        .setDescription('スパム対策の設定を行います。（権限: 管理者）')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addIntegerOption(option => 
            option.setName('limit')
                .setDescription(`許容メッセージ数（N）。デフォルト: ${DEFAULT_SETTINGS.limit}`)
                .setRequired(true)
        )
        .addIntegerOption(option => 
            option.setName('duration')
                .setDescription(`監視する時間（秒）。デフォルト: ${DEFAULT_SETTINGS.duration}秒`)
                .setRequired(true)
        )
        .addIntegerOption(option => 
            option.setName('timeout-duration')
                .setDescription(`タイムアウト時間（秒）。デフォルト: ${DEFAULT_SETTINGS.timeoutDuration}秒 (5分)`)
                .setRequired(true)
        ),
    // 2. 設定表示コマンド
    new SlashCommandBuilder()
        .setName('show-spam-settings')
        .setDescription('現在のスパム設定を表示します。'),

    // 3. メッセージ削除コマンド (新機能)
    new SlashCommandBuilder()
        .setName('message-delete')
        .setDescription('指定したユーザーのメッセージを大量削除します。')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
        .addUserOption(option => 
            option.setName('user')
                .setDescription('メッセージを削除する対象ユーザーを指定')
                .setRequired(true)
        )
        .addStringOption(deleteRangeOption)
];

// スラッシュコマンドをDiscordに登録する関数
async function registerSlashCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('スラッシュコマンドの登録を開始...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands.map(command => command.toJSON()) },
        );
        console.log('スラッシュコマンドの登録が完了しました。');
    } catch (error) {
        console.error('スラッシュコマンドの登録中にエラー:', error);
    }
}

// ===========================================
// コマンド実行処理
// ===========================================

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || !interaction.guildId) return;

    const { commandName, guildId } = interaction;
    const member = interaction.member;

    // --- 権限チェック ---
    if (commandName === 'message-delete' && !member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return interaction.reply({ content: '❌ このコマンドは「メッセージの管理」権限を持つメンバーのみが実行できます。', ephemeral: true });
    }
    if (commandName === 'set-spam-settings' && !member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: '❌ このコマンドは「サーバーの管理」権限を持つメンバーのみが実行できます。', ephemeral: true });
    }

    // --- スパム設定コマンドの処理 ---
    if (commandName === 'set-spam-settings') {
        const limit = interaction.options.getInteger('limit');
        const duration = interaction.options.getInteger('duration');
        const timeoutDuration = interaction.options.getInteger('timeout-duration');
        const newSettings = { limit, duration, timeoutDuration };
        await saveSpamSettings(guildId, newSettings);

        await interaction.reply({ 
            content: `✅ スパム制限を設定しました。\n` +
                     `許容メッセージ数（N）: **${limit}**\n` +
                     `監視時間: **${duration}秒**\n` +
                     `タイムアウト時間: **${timeoutDuration}秒**`
        });
    }
    
    // --- 設定表示コマンドの処理 ---
    else if (commandName === 'show-spam-settings') {
        const settings = await getSpamSettings(guildId);
        await interaction.reply({
            content: `📝 **現在のスパム制限設定**\n` +
                     `許容メッセージ数（N）: **${settings.limit}**\n` +
                     `監視時間: **${settings.duration}秒**\n` +
                     `タイムアウト時間: **${settings.timeoutDuration}秒**`
        });
    }

    // --- メッセージ削除コマンドの処理 (新機能) ---
    else if (commandName === 'message-delete') {
        const targetUser = interaction.options.getUser('user');
        const rangeInput = interaction.options.getString('range');
        const channel = interaction.channel;

        if (channel.type !== ChannelType.GuildText) {
            return interaction.reply({ content: '❌ テキストチャンネルでのみ実行可能です。', ephemeral: true });
        }
        
        await interaction.deferReply({ ephemeral: true });

        try {
            let deleteCount = 0;
            
            if (rangeInput.toLowerCase() === 'all') {
                // "all" の場合、そのユーザーのメッセージをすべて削除（ただしDiscordのAPI制限により過去14日分まで）
                const messages = await channel.messages.fetch({ limit: 100 });
                const userMessages = messages.filter(m => m.author.id === targetUser.id);
                
                if (userMessages.size > 0) {
                    await channel.bulkDelete(userMessages, true);
                    deleteCount = userMessages.size;
                }
                
                await interaction.editReply({ 
                    content: `🗑️ **${targetUser.username}** の直近100件のメッセージから、該当する**${deleteCount}件**のメッセージを削除しました。\n(※Discordの仕様により、14日以上前のメッセージは削除できません)` 
                });

            } else {
                // 数値指定の場合 (1〜99)
                const limit = parseInt(rangeInput);
                
                if (isNaN(limit) || limit < 1 || limit > 99) {
                    return interaction.editReply({ content: '❌ 削除範囲は1から99の数値、または "all" で指定してください。' });
                }

                const messages = await channel.messages.fetch({ limit: 100 });
                const messagesToDelete = messages
                    .filter(m => m.author.id === targetUser.id)
                    .first(limit);

                if (messagesToDelete.length === 0) {
                    return interaction.editReply({ content: `✅ **${targetUser.username}** のメッセージは見つかりませんでした。` });
                }

                await channel.bulkDelete(messagesToDelete, true);
                deleteCount = messagesToDelete.length;

                await interaction.editReply({ 
                    content: `🗑️ **${targetUser.username}** の直近のメッセージから**${deleteCount}件**を削除しました。` 
                });
            }

        } catch (error) {
            console.error('メッセージ削除中にエラーが発生:', error);
            interaction.editReply({ content: '⚠️ メッセージ削除中にエラーが発生しました。Botに「メッセージの管理」権限と、削除対象より上位のロールがあるか確認してください。' });
        }
    }
});


// ===========================================
// メッセージイベント処理 (スパム監視)
// ===========================================

client.on('messageCreate', async (message) => {
    // Bot自身のメッセージやDMは無視します
    if (message.author.bot || !message.guild || !message.guildId) return;

    const userId = message.author.id;
    const guildId = message.guildId;
    const now = Date.now();

    // 1. スパム設定とユーザーログの準備
    const settings = await getSpamSettings(guildId);
    initializeUserLog(guildId, userId);
    const userLog = spamLog[guildId][userId];
    
    // 監視時間（Duration）のミリ秒換算
    const SPAM_WINDOW_MS = settings.duration * 1000;
    
    // 2. 過去のメッセージログをクリーンアップ (監視時間より古いものを削除)
    userLog.messages = userLog.messages.filter(msg => now - msg.timestamp < SPAM_WINDOW_MS);
    
    // 3. 現在のメッセージをログに追加
    userLog.messages.push({ timestamp: now, channelId: message.channelId });

    // 4. スパム判定: 監視時間内のメッセージ数が許容数を超えているか
    if (userLog.messages.length > settings.limit) {
        // スパムと判定！
        try {
            const member = message.member;
            const timeoutDurationMs = settings.timeoutDuration * 1000;
            
            // ユーザーをタイムアウト
            await member.timeout(timeoutDurationMs, `スパム制限(${settings.limit}メッセージ/${settings.duration}秒)を超過`);

            // 警告とアクションのメッセージ
            message.channel.send(`🚨 **${message.author.username}** はスパム行為（${settings.duration}秒間に${settings.limit + 1}回以上の発言）が検出されたため、${settings.timeoutDuration}秒間タイムアウトされました。`);

            // タイムアウト後、そのユーザーのログをリセット
            userLog.messages = [];
            
        } catch (error) {
            console.error(`ユーザー ${message.author.tag} のタイムアウト処理中にエラー:`, error);
            // 権限がない場合のエラーメッセージ
            message.channel.send(`⚠️ スパム行為が検出されましたが、Botに権限がないためタイムアウトできませんでした。Botのロールと権限を確認してください。`);
        }
    }
});


// BotをDiscordに接続します
client.login(process.env.DISCORD_TOKEN);

