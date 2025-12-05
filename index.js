require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { Telegraf, Markup, session: TelegrafSession } = require('telegraf');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Telegraf Bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// User Schema
const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    githubId: String,
    githubAccessToken: String,
    githubUsername: String,
    isAgreed: { type: Boolean, default: false },
    isConnected: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now },
    repositories: [{
        name: String,
        full_name: String,
        url: String,
        private: Boolean
    }]
});

const User = mongoose.model('User', userSchema);

// Cache file for Render memory persistence
const CACHE_FILE = path.join(__dirname, 'data.json');

function readCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error reading cache:', error);
    }
    return {};
}

function writeCache(key, value) {
    try {
        const cache = readCache();
        cache[key] = value;
        cache.lastUpdated = new Date().toISOString();
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    } catch (error) {
        console.error('Error writing cache:', error);
    }
}

function getFromCache(key) {
    const cache = readCache();
    return cache[key];
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Serve HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'agreement.html'));
});

app.get('/agreement', (req, res) => {
    res.sendFile(path.join(__dirname, 'agreement.html'));
});

app.get('/success', (req, res) => {
    res.sendFile(path.join(__dirname, 'success.html'));
});

app.get('/error', (req, res) => {
    res.sendFile(path.join(__dirname, 'error.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'GitHub Management Bot'
    });
});

// API Endpoints
app.post('/api/user/agree', async (req, res) => {
    try {
        const { telegramId } = req.body;
        
        // Check if user exists in cache first
        let user = getFromCache(`user_${telegramId}`);
        
        if (!user) {
            user = await User.findOne({ telegramId });
        }
        
        if (user) {
            user.isAgreed = true;
            user.lastActive = new Date();
            await user.save();
        } else {
            user = new User({
                telegramId,
                isAgreed: true,
                lastActive: new Date()
            });
            await user.save();
        }
        
        // Update cache
        writeCache(`user_${telegramId}`, user);
        
        res.json({ success: true, message: 'Agreement accepted' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/user/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        
        // Check cache first
        let user = getFromCache(`user_${telegramId}`);
        
        if (!user) {
            user = await User.findOne({ telegramId });
            if (user) {
                writeCache(`user_${telegramId}`, user);
            }
        }
        
        res.json(user || {});
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GitHub OAuth endpoints
app.get('/auth/github', async (req, res) => {
    const { telegramId } = req.query;
    
    if (!telegramId) {
        return res.redirect('/error?error=No Telegram ID');
    }
    
    // Store telegramId in session/cache
    writeCache(`oauth_${telegramId}`, { 
        telegramId, 
        timestamp: Date.now() 
    });
    
    // Redirect to GitHub OAuth
    const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=user repo delete_repo&redirect_uri=${process.env.FRONTEND_URL}/auth/github/callback&state=${telegramId}`;
    
    res.redirect(githubAuthUrl);
});

app.get('/auth/github/callback', async (req, res) => {
    try {
        const { code, state: telegramId } = req.query;
        
        if (!code || !telegramId) {
            return res.redirect('/error?error=Missing parameters');
        }
        
        // Exchange code for access token
        const tokenResponse = await axios.post('https://github.com/login/oauth/access_token', {
            client_id: process.env.GITHUB_CLIENT_ID,
            client_secret: process.env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: `${process.env.FRONTEND_URL}/auth/github/callback`
        }, {
            headers: {
                'Accept': 'application/json'
            }
        });
        
        const { access_token } = tokenResponse.data;
        
        if (!access_token) {
            return res.redirect('/error?error=No access token');
        }
        
        // Get user info from GitHub
        const userResponse = await axios.get('https://api.github.com/user', {
            headers: {
                'Authorization': `token ${access_token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        const githubUser = userResponse.data;
        
        // Update user in database
        const user = await User.findOneAndUpdate(
            { telegramId },
            {
                githubId: githubUser.id,
                githubAccessToken: access_token,
                githubUsername: githubUser.login,
                isConnected: true,
                lastActive: new Date()
            },
            { upsert: true, new: true }
        );
        
        // Update cache
        writeCache(`user_${telegramId}`, user);
        
        // Notify bot
        try {
            await bot.telegram.sendMessage(
                telegramId,
                `✅ *GitHub Account Connected!*\n\n` +
                `Successfully connected to GitHub account: *${githubUser.login}*\n\n` +
                `Now you can use all features:\n` +
                `• /repos - List your repositories\n` +
                `• /createrepo - Create new repository\n` +
                `• /files - Manage repository files\n` +
                `• /help - Show all commands`,
                { parse_mode: 'Markdown' }
            );
        } catch (botError) {
            console.error('Error notifying bot:', botError);
        }
        
        // Redirect to success page
        res.redirect(`/success?telegramId=${telegramId}`);
        
    } catch (error) {
        console.error('GitHub OAuth Error:', error);
        res.redirect('/error?error=' + encodeURIComponent(error.message));
    }
});

// GitHub API proxy endpoints
app.post('/api/github/repos', async (req, res) => {
    try {
        const { telegramId } = req.body;
        
        const user = await User.findOne({ telegramId });
        if (!user || !user.githubAccessToken) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        
        // Check cache first
        const cacheKey = `repos_${telegramId}`;
        const cachedRepos = getFromCache(cacheKey);
        
        if (cachedRepos && Date.now() - new Date(cachedRepos.cachedAt).getTime() < 5 * 60 * 1000) {
            return res.json(cachedRepos.data);
        }
        
        // Fetch from GitHub API
        const response = await axios.get('https://api.github.com/user/repos', {
            headers: {
                'Authorization': `token ${user.githubAccessToken}`,
                'Accept': 'application/vnd.github.v3+json'
            },
            params: {
                per_page: 100,
                sort: 'updated'
            }
        });
        
        const repos = response.data;
        
        // Update user's repositories
        user.repositories = repos.map(repo => ({
            name: repo.name,
            full_name: repo.full_name,
            url: repo.html_url,
            private: repo.private
        }));
        await user.save();
        
        // Update cache
        writeCache(cacheKey, {
            data: repos,
            cachedAt: new Date().toISOString()
        });
        
        writeCache(`user_${telegramId}`, user);
        
        res.json(repos);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Telegram Bot Commands

// Start command
bot.start(async (ctx) => {
    const telegramId = ctx.from.id.toString();
    
    try {
        // Check cache first
        let user = getFromCache(`user_${telegramId}`);
        
        if (!user) {
            const response = await axios.get(`${process.env.FRONTEND_URL}/api/user/${telegramId}`);
            user = response.data;
        }
        
        if (user && user.isAgreed) {
            if (user.githubAccessToken) {
                await sendMainMenu(ctx);
            } else {
                await sendConnectPrompt(ctx);
            }
        } else {
            await sendAgreement(ctx);
        }
    } catch (error) {
        await sendAgreement(ctx);
    }
});

async function sendAgreement(ctx) {
    const telegramId = ctx.from.id.toString();
    const agreementUrl = `${process.env.AGREEMENT_URL}?telegramId=${telegramId}`;
    
    await ctx.reply(
        `📜 *Welcome to GitHub Management Bot!*\n\n` +
        `Before we begin, you need to agree to our Terms of Service.\n\n` +
        `*Please visit:*\n` +
        `${agreementUrl}\n\n` +
        `After agreeing, return here and tap "✅ I've Agreed" below.`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.url('📖 Read & Agree', agreementUrl)],
                [Markup.button.callback('✅ I\'ve Agreed', 'check_agreement')]
            ])
        }
    );
}

async function sendConnectPrompt(ctx) {
    await ctx.reply(
        `🔗 *Connect Your GitHub Account*\n\n` +
        `To use all features, connect your GitHub account:\n\n` +
        `Use command: /connect\n\n` +
        `Or tap the button below to connect now.`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔗 Connect GitHub', 'connect_github')]
            ])
        }
    );
}

async function sendMainMenu(ctx) {
    await ctx.reply(
        `🎯 *GitHub Management Bot*\n\n` +
        `Select what you want to do:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback('📚 My Repos', 'list_repos'),
                    Markup.button.callback('➕ Create Repo', 'create_repo')
                ],
                [
                    Markup.button.callback('📁 Files', 'manage_files'),
                    Markup.button.callback('⚙️ Settings', 'bot_settings')
                ],
                [
                    Markup.button.callback('ℹ️ About', 'about_bot'),
                    Markup.button.callback('🆘 Help', 'show_help')
                ]
            ])
        }
    );
}

// Connect command
bot.command('connect', async (ctx) => {
    const telegramId = ctx.from.id.toString();
    const authUrl = `${process.env.FRONTEND_URL}/auth/github?telegramId=${telegramId}`;
    
    await ctx.reply(
        `🔐 *Connect GitHub Account*\n\n` +
        `Click the link below to authorize:\n\n` +
        `${authUrl}\n\n` +
        `After authorization, return here.`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.url('🔗 Authorize GitHub', authUrl)],
                [Markup.button.callback('✅ Check Connection', 'check_github_connection')]
            ])
        }
    );
});

// Repos command
bot.command('repos', async (ctx) => {
    const telegramId = ctx.from.id.toString();
    
    try {
        const user = await User.findOne({ telegramId });
        
        if (!user || !user.githubAccessToken) {
            return ctx.reply(
                `❌ *No GitHub Connection*\n\n` +
                `Please connect your GitHub account first:\n\n` +
                `/connect`,
                { parse_mode: 'Markdown' }
            );
        }
        
        await ctx.reply('⏳ Fetching your repositories...');
        
        const response = await axios.post(`${process.env.FRONTEND_URL}/api/github/repos`, {
            telegramId
        });
        
        const repos = response.data;
        
        if (!repos || repos.length === 0) {
            return ctx.reply(
                `📭 *No Repositories Found*\n\n` +
                `You don't have any repositories yet.\n\n` +
                `Create one with /createrepo`,
                { parse_mode: 'Markdown' }
            );
        }
        
        let message = `📚 *Your Repositories (${repos.length})*\n\n`;
        
        repos.slice(0, 5).forEach((repo, index) => {
            message += `${index + 1}. *${repo.full_name}*\n`;
            message += `   📝 ${repo.description || 'No description'}\n`;
            message += `   🌟 ${repo.stargazers_count} stars\n`;
            message += `   ${repo.private ? '🔒 Private' : '🌐 Public'}\n\n`;
        });
        
        if (repos.length > 5) {
            message += `... and ${repos.length - 5} more repositories.\n`;
        }
        
        await ctx.reply(message, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback('🔄 Refresh', 'refresh_repos'),
                    Markup.button.callback('📁 View All', 'view_all_repos')
                ]
            ])
        });
        
    } catch (error) {
        await ctx.reply(
            `❌ *Error fetching repositories*\n\n` +
            `Please try again later.\n\n` +
            `Error: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
});

// Create repo command
bot.command('createrepo', async (ctx) => {
    await ctx.reply(
        `🆕 *Create New Repository*\n\n` +
        `To create a repository, use:\n\n` +
        `\`/newrepo [name] [description] [private]\`\n\n` +
        `*Example:*\n` +
        `\`/newrepo my-project "My awesome project" private\`\n` +
        `\`/newrepo open-source "Open source project"\`\n\n` +
        `Or use the web interface:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.url('🌐 Create on GitHub', 'https://github.com/new')]
            ])
        }
    );
});

// New repo command handler
bot.command('newrepo', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length < 1) {
        return ctx.reply(
            `❌ *Usage:*\n` +
            `\`/newrepo [name] [description] [private]\`\n\n` +
            `*Example:*\n` +
            `\`/newrepo my-project "My project" private\``,
            { parse_mode: 'Markdown' }
        );
    }
    
    const name = args[0];
    const description = args.slice(1, args.length - (args[args.length - 1] === 'private' ? 1 : 0)).join(' ');
    const isPrivate = args[args.length - 1] === 'private';
    
    const telegramId = ctx.from.id.toString();
    
    try {
        const user = await User.findOne({ telegramId });
        
        if (!user || !user.githubAccessToken) {
            return ctx.reply('❌ Please connect GitHub first with /connect');
        }
        
        await ctx.reply('⏳ Creating repository...');
        
        const response = await axios.post(
            'https://api.github.com/user/repos',
            {
                name,
                description,
                private: isPrivate,
                auto_init: true
            },
            {
                headers: {
                    'Authorization': `token ${user.githubAccessToken}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }
        );
        
        const repo = response.data;
        
        await ctx.reply(
            `✅ *Repository Created!*\n\n` +
            `*Name:* ${repo.full_name}\n` +
            `*URL:* ${repo.html_url}\n` +
            `*Status:* ${repo.private ? '🔒 Private' : '🌐 Public'}\n\n` +
            `You can now push code to this repository.`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🔗 Open Repository', repo.html_url)]
                ])
            }
        );
        
    } catch (error) {
        await ctx.reply(
            `❌ *Error creating repository*\n\n` +
            `Error: ${error.response?.data?.message || error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
});

// Files command
bot.command('files', async (ctx) => {
    await ctx.reply(
        `📁 *Manage Repository Files*\n\n` +
        `To view files, use:\n\n` +
        `\`/listfiles [owner]/[repo]\`\n\n` +
        `*Example:*\n` +
        `\`/listfiles octocat/Hello-World\`\n\n` +
        `To delete a file:\n` +
        `\`/deletefile [owner]/[repo] [file-path]\``,
        { parse_mode: 'Markdown' }
    );
});

// Delete file command
bot.command('deletefile', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length < 2) {
        return ctx.reply(
            `❌ *Usage:*\n` +
            `\`/deletefile [owner]/[repo] [file-path]\`\n\n` +
            `*Example:*\n` +
            `\`/deletefile octocat/Hello-World README.md\``,
            { parse_mode: 'Markdown' }
        );
    }
    
    const [repoPath, filePath] = args;
    
    await ctx.reply(
        `⚠️ *Delete File*\n\n` +
        `Repository: \`${repoPath}\`\n` +
        `File: \`${filePath}\`\n\n` +
        `Are you sure you want to delete this file?`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback('✅ Yes, Delete', `delete_confirm_${repoPath}_${filePath}`),
                    Markup.button.callback('❌ Cancel', 'cancel_delete')
                ]
            ])
        }
    );
});

// About command
bot.command('about', async (ctx) => {
    await ctx.reply(
        `🤖 *GitHub Management Bot*\n\n` +
        `Version: 1.0.0\n` +
        `Bot: @GitHubmngbot\n\n` +
        `*Features:*\n` +
        `• 📚 List & manage repositories\n` +
        `• 🆕 Create new repositories\n` +
        `• 📁 File management\n` +
        `• ✏️ Edit repository details\n` +
        `• 🔄 Real-time sync\n\n` +
        `*Developer Contact:*\n` +
        `🔗 [Portfolio](https://ximanta.onrender.com)\n` +
        `📧 xiimnta@outlook.com\n\n` +
        `*GitHub Repository:*\n` +
        `[github-mng-bot](https://github.com/tukuexe/github-mng-bot)`,
        {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...Markup.inlineKeyboard([
                [Markup.button.url('🌟 Star on GitHub', 'https://github.com/tukuexe/github-mng-bot')],
                [Markup.button.url('📞 Contact Support', 'https://t.me/tukuexe')]
            ])
        }
    );
});

// Help command
bot.command('help', async (ctx) => {
    const commands = [
        '/start - Start the bot',
        '/connect - Connect GitHub account',
        '/repos - List your repositories',
        '/createrepo - Create new repository',
        '/newrepo [name] [desc] - Create repo',
        '/files - File management',
        '/listfiles [repo] - List files',
        '/deletefile [repo] [file] - Delete file',
        '/about - About this bot',
        '/help - Show this help'
    ];
    
    await ctx.reply(
        `🆘 *Available Commands:*\n\n${commands.join('\n')}\n\n` +
        `*Need Help?*\n` +
        `Contact: @tukuexe\n\n` +
        `*GitHub API Status:* [status.github.com](https://www.githubstatus.com/)`,
        {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        }
    );
});

// Callback query handlers
bot.action('check_agreement', async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from.id.toString();
    
    try {
        const response = await axios.get(`${process.env.FRONTEND_URL}/api/user/${telegramId}`);
        const user = response.data;
        
        if (user && user.isAgreed) {
            await ctx.reply('✅ *Agreement confirmed!*\n\nNow let\'s connect your GitHub account.', {
                parse_mode: 'Markdown'
            });
            await sendConnectPrompt(ctx);
        } else {
            await ctx.reply('❌ You haven\'t agreed yet. Please click the link and agree first.');
        }
    } catch (error) {
        await ctx.reply('❌ Error checking agreement. Please try again.');
    }
});

bot.action('connect_github', async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from.id.toString();
    const authUrl = `${process.env.FRONTEND_URL}/auth/github?telegramId=${telegramId}`;
    
    await ctx.reply(
        `Click the link to authorize:\n${authUrl}`,
        Markup.inlineKeyboard([
            [Markup.button.url('🔗 Authorize', authUrl)],
            [Markup.button.callback('✅ Done', 'check_github_connection')]
        ])
    );
});

bot.action('check_github_connection', async (ctx) => {
    await ctx.answerCbQuery('Checking...');
    const telegramId = ctx.from.id.toString();
    
    try {
        const user = await User.findOne({ telegramId });
        
        if (user && user.githubAccessToken) {
            await ctx.reply(
                `✅ *GitHub Connected!*\n\n` +
                `Username: ${user.githubUsername}\n\n` +
                `Now you can use all features. Try /repos to see your repositories.`,
                { parse_mode: 'Markdown' }
            );
            await sendMainMenu(ctx);
        } else {
            await ctx.reply('❌ Not connected yet. Please use /connect first.');
        }
    } catch (error) {
        await ctx.reply('❌ Error checking connection.');
    }
});

bot.action('list_repos', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Use /repos to list your repositories.');
});

bot.action('create_repo', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Use /createrepo to create a new repository.');
});

bot.action('manage_files', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Use /files for file management options.');
});

bot.action('about_bot', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Use /about to learn more about the bot.');
});

bot.action('show_help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Use /help for all available commands.');
});

// Error handling
bot.catch((err, ctx) => {
    console.error(`Bot error for ${ctx.updateType}:`, err);
    ctx.reply('❌ An error occurred. Please try again.');
});

// Set up webhook
const webhookCallback = bot.webhookCallback('/bot-webhook');

app.post('/bot-webhook', (req, res) => {
    webhookCallback(req, res);
});

// Set webhook on startup
async function setupWebhook() {
    try {
        const webhookUrl = `${process.env.WEBHOOK_URL}/bot-webhook`;
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`✅ Webhook set to: ${webhookUrl}`);
    } catch (error) {
        console.error('❌ Error setting webhook:', error);
    }
}

// Start server
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔗 Frontend URL: ${process.env.FRONTEND_URL}`);
    console.log(`🤖 Bot: @${process.env.BOT_USERNAME}`);
    
    // Setup webhook
    await setupWebhook();
    
    // Start bot in polling mode for development
    if (process.env.NODE_ENV !== 'production') {
        bot.launch().then(() => {
            console.log('🤖 Bot running in polling mode');
        });
    }
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));