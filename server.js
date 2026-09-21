require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const mongoose = require('mongoose');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const User = require('./models/User');
const Notification = require('./models/Notifications');

// 1. INITIALIZE APP FIRST
const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy if behind Vercel/reverse proxy (critical for secure cookies)
app.set('trust proxy', 1);

// 2. VIEW ENGINE & STATIC ASSETS
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 3. SESSION MIDDLEWARE
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback_secret_key_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 1 week session limit
    }
}));

// --- VERCEL-SAFE MONGODB SINGLETON CONNECTION ---
let cachedMongoose = global.mongooseConn;
if (!cachedMongoose) {
    cachedMongoose = global.mongooseConn = { conn: null, promise: null };
}

async function connectDB() {
    if (cachedMongoose.conn) return cachedMongoose.conn;
    if (!cachedMongoose.promise) {
        cachedMongoose.promise = mongoose.connect(process.env.MONGO_URI, {
            bufferCommands: false,
            serverSelectionTimeoutMS: 5000,
        }).then((m) => {
            console.log('[MongoDB] Connected to MongoDB Atlas successfully!');
            return m;
        });
    }
    try {
        cachedMongoose.conn = await cachedMongoose.promise;
    } catch (err) {
        cachedMongoose.promise = null;
        console.error('[MongoDB] Connection error:', err.message);
        throw err;
    }
    return cachedMongoose.conn;
}

// Ensure database connection middleware for routes that need DB
app.use(async (req, res, next) => {
    try {
        await connectDB();
    } catch (e) {
        // Non-blocking for static assets, or let route handle error
    }
    next();
});

// --- LAZY SERVERLESS DISCORD CLIENT ---
let discordClient = null;

function getDiscordClient() {
    if (!discordClient && process.env.DISCORD_BOT_TOKEN) {
        discordClient = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMembers
            ]
        });

        discordClient.once('ready', () => {
            console.log(`[Discord Bot] Logged in as ${discordClient.user.tag}!`);
            const TARGET_GUILD_ID = process.env.DISCORD_GUILD_ID;
            if (TARGET_GUILD_ID && process.env.NODE_ENV !== 'production') {
                const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
                setTimeout(() => cleanupInactiveUsers(TARGET_GUILD_ID), 10000);
                setInterval(() => cleanupInactiveUsers(TARGET_GUILD_ID), TWENTY_FOUR_HOURS);
            }
        });

        discordClient.login(process.env.DISCORD_BOT_TOKEN).catch(e => {
            console.error('[Discord Bot Login Error]:', e.message);
            discordClient = null;
        });
    }
    return discordClient;
}

// Trigger lazy init safely in background if token exists
if (process.env.DISCORD_BOT_TOKEN) {
    getDiscordClient();
} else {
    console.log('[Discord Bot] Warning: DISCORD_BOT_TOKEN missing from .env.');
}

// --- AUTOMATED CLEANUP WORKER ---
async function cleanupInactiveUsers(guildId) {
    if (!guildId) return;
    try {
        await connectDB();
        const clientInstance = getDiscordClient();
        if (!clientInstance) return;

        console.log('[Cleanup Worker] Starting inactive/departed user check...');
        const users = await User.find({});

        const guild = await clientInstance.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
            console.log('[Cleanup Worker] Error: Guild could not be fetched.');
            return;
        }

        await guild.members.fetch();

        const fourteenDaysAgo = new Date(Date.now() - (14 * 24 * 60 * 60 * 1000));
        let deletedCount = 0;

        for (const user of users) {
            let shouldDelete = false;
            let reason = '';

            const member = guild.members.cache.get(user.id);
            if (!member) {
                shouldDelete = true;
                reason = 'Left Discord server';
            } else if (user.lastActive && new Date(user.lastActive) < fourteenDaysAgo) {
                shouldDelete = true;
                reason = 'Inactive on website for over 14 days';
            }

            if (shouldDelete) {
                await User.deleteOne({ id: user.id });
                deletedCount++;
                console.log(`[Cleanup Worker] Removed user ${user.username} (${user.id}):${reason}`);
            }
        }

        console.log(`[Cleanup Worker] Finished. Removed ${deletedCount} user(s).`);
    } catch (err) {
        console.error('[Cleanup Worker] Error during user cleanup routine:', err.message);
    }
}

// --- MIDDLEWARE & HELPERS ---
function isAdmin(req, res, next) {
    if (!req.session || !req.session.user) return res.redirect('/');

    const ADMIN_DISCORD_IDS = [
        '895054825316839424',
        '698645469907124346'
    ];

    if (ADMIN_DISCORD_IDS.includes(req.session.user.id)) {
        return next();
    }

    res.redirect('/dashboard');
}

// Automatically update user's lastActive timestamp safely
app.use((req, res, next) => {
    if (req.session && req.session.user && mongoose.connection.readyState === 1) {
        User.updateOne({ id: req.session.user.id }, { $set: { lastActive: new Date() } }).catch(() => {});
    }
    next();
});

const LOG_CHANNEL_ID = '1547698170480431205';

async function sendImportantLog(title, description, color = 0x3b82f6, fields = []) {
    try {
        const clientInstance = getDiscordClient();
        if (!clientInstance || !clientInstance.isReady()) return;
        const channel = await clientInstance.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`🛡️ [IMPORTANT EVENT] ${title}`)
            .setDescription(description)
            .addFields(fields)
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error('[Activity Logger] Failed to send log to Discord:', err.message);
    }
}

// --- ROUTES ---

// Home Page
app.get('/', (req, res) => {
    res.render('index', { user: req.session.user || null });
});

app.get('/profile', async (req, res) => {
    if (!req.session.user) return res.redirect('/');

    try {
        const dbUser = await User.findOne({ id: req.session.user.id });

        const userProfile = {
            ...req.session.user,
            whitelistStatus: dbUser ? dbUser.whitelistStatus : 'Pending Review',
            department: dbUser ? dbUser.department : 'Unassigned',
            callsign: dbUser ? dbUser.callsign : 'Unassigned',
            fivemId: 'Not Linked',
            patrolHours: '0 hrs',
            strikes: dbUser ? `${dbUser.strikes} Strikes` : '0 Strikes',
            joinedDate: dbUser ? dbUser.submittedDate : 'September 2026'
        };

        res.render('profile', { user: userProfile });
    } catch (err) {
        console.error("Error loading profile:", err);
        res.status(500).send("Server Error loading profile.");
    }
});

// Admin Panel Overview
app.get('/admin', isAdmin, async (req, res) => {
    try {
        const users = await User.find({}).lean();
        const dbUser = await User.findOne({ id: req.session.user.id });

        const totalUsers = users.length;
        const pendingCount = users.filter(u => !u.whitelistStatus || u.whitelistStatus === 'Pending' || u.whitelistStatus === 'Pending Review').length;
        const approvedCount = users.filter(u => u.whitelistStatus === 'Approved').length;

        res.render('admin', {
            user: req.session.user,
            users,
            totalUsers,
            pendingCount,
            approvedCount,
            dbUser: dbUser || req.session.user
        });
    } catch (err) {
        console.error('Error fetching admin users:', err);
        res.status(500).send('Server Error loading admin dashboard');
    }
});

// Individual User Edit Panel
app.get('/admin/user/:id', isAdmin, async (req, res) => {
    try {
        const targetUser = await User.findOne({ id: req.params.id }).lean();
        if (!targetUser) {
            return res.status(404).render('error', { message: 'User record not found.' });
        }

        res.render('admin-edit-user', {
            user: req.session.user,
            targetUser
        });
    } catch (err) {
        console.error('Error loading target user:', err);
        res.status(500).send('Server Error');
    }
});

// Save Changes to User
app.post('/admin/user/:id', isAdmin, async (req, res) => {
    try {
        const { callsign, department, whitelistStatus, strikes } = req.body;

        const parsedStrikes = parseInt(strikes);
        const updatedStrikes = isNaN(parsedStrikes) ? 0 : parsedStrikes;

        const existingUserRecord = await User.findOne({ id: req.params.id });
        const oldStatus = existingUserRecord ? existingUserRecord.whitelistStatus : 'Pending Review';
        const statusChanged = oldStatus !== whitelistStatus;

        await User.findOneAndUpdate(
            { id: req.params.id },
            {
                $set: {
                    callsign: callsign ? callsign.trim() : 'Unassigned',
                    department: department ? department.trim() : 'Unassigned',
                    whitelistStatus: whitelistStatus || 'Pending Review',
                    strikes: updatedStrikes
                }
            },
            { returnDocument: 'after' }
        );

        const adminUser = req.session.user;

        sendImportantLog(
            'Admin Modified User Profile',
            `Administrator **${adminUser ? adminUser.username : 'Unknown'}** updated a user record.`,
            0xf59e0b,
            [
                { name: 'Target User ID', value: `\`${req.params.id}\``, inline: true },
                { name: 'New Status', value: `\`${whitelistStatus}\``, inline: true },
                { name: 'Department / Callsign', value: `${department \vert{}\vert{} 'Unassigned'} /${callsign || 'Unassigned'}`, inline: false }
            ]
        );

        try {
            const clientInstance = getDiscordClient();
            if (clientInstance) {
                const discordUser = await clientInstance.users.fetch(req.params.id);

                if (discordUser) {
                    let targetEmbed;

                    if (statusChanged) {
                        let embedColor = 0xf59e0b;
                        let statusDescription = `Your application is currently set to **Pending Review**.`;

                        if (whitelistStatus === 'Approved') {
                            embedColor = 0x10b981;
                            statusDescription = `🎉 **Congratulations!** You have been accepted into the community.\n\n` +
                                `• **Department:** ${department || 'Unassigned'}\n` +
                                `• **Callsign:** ${callsign || 'Unassigned'}`;
                        } else if (whitelistStatus === 'Denied') {
                            embedColor = 0xef4444;
                            statusDescription = `❌ Unfortunately, your application was denied at this time. Feel free to contact staff for more details.`;
                        }

                        targetEmbed = new EmbedBuilder()
                            .setColor(embedColor)
                            .setTitle('📋 UPN LEADER HAS REVIEWED')
                            .setDescription(`Hello **${discordUser.username}**, your application status has been reviewed and updated by a community leader.`)
                            .addFields(
                                { name: 'New Application Status', value: `**${whitelistStatus}**`, inline: true },
                                { name: 'Active Strikes', value: `**${updatedStrikes}**`, inline: true },
                                { name: '\u200b', value: '\u200b', inline: false },
                                { name: 'Assignment Details', value: statusDescription },
                                { name: 'Reviewed By', value: `*${adminUser ? adminUser.username : 'Server Administrator'}*`, inline: false }
                            );
                    } else {
                        targetEmbed = new EmbedBuilder()
                            .setColor(0x3b82f6)
                            .setTitle('🛡️ UPN PROFILE UPDATED')
                            .setDescription(`Hello **${discordUser.username}**, your member profile details have been updated by a community leader.`)
                            .addFields(
                                { name: 'Department', value: `**${department || 'Unassigned'}**`, inline: true },
                                { name: 'Callsign', value: `**${callsign || 'Unassigned'}**`, inline: true },
                                { name: 'Active Strikes', value: `**${updatedStrikes}**`, inline: true },
                                { name: 'Updated By', value: `*${adminUser ? adminUser.username : 'Server Administrator'}*`, inline: false }
                            );
                    }

                    targetEmbed
                        .setTimestamp()
                        .setFooter({
                            text: 'UPN Management & Security System',
                            iconURL: adminUser ? `https://cdn.discordapp.com/avatars/${adminUser.id}/${adminUser.avatar}.png` : null
                        });

                    await discordUser.send({ embeds: [targetEmbed] });
                }
            }
        } catch (dmErr) {
            console.log(`[Discord DM] Could not send message to user ${req.params.id}:`, dmErr.message);
        }
        res.redirect('/admin');
    } catch (err) {
        console.error('Error updating user profile:', err);
        res.status(500).send('Server Error saving user updates');
    }
});

// Database Overview with Collections, Fields & Counts
app.get('/admin-database', isAdmin, async (req, res) => {
    try {
        const collectionsData = [];
        const modelNames = mongoose.modelNames();

        for (const name of modelNames) {
            const model = mongoose.model(name);
            const count = await model.countDocuments();

            const paths = model.schema.paths;
            const fields = Object.keys(paths).map(field => ({
                name: field,
                type: paths[field].instance
            }));

            const sampleDocs = await model.find().sort({ _id: -1 }).limit(10).lean();

            collectionsData.push({
                name,
                count,
                fields,
                sampleDocs
            });
        }

        res.render('admin-database', {
            user: req.session.user,
            collections: collectionsData
        });
    } catch (err) {
        console.error("Error loading database viewer:", err);
        res.status(500).send("Error loading database viewer.");
    }
});

// Delete a specific document/user by ID from any collection
app.post('/admin/database/:modelName/delete/:id', isAdmin, async (req, res) => {
    try {
        const { modelName, id } = req.params;
        const model = mongoose.model(modelName);

        let deleted;
        if (mongoose.Types.ObjectId.isValid(id) && id.length === 24) {
            deleted = await model.findByIdAndDelete(id);
        } else {
            deleted = await model.findOneAndDelete({ id: id });
        }

        if (!deleted) {
            await model.deleteOne({ _id: id }).catch(() => {});
        }

        console.log(`[Admin DB] Deleted record ${id} from model ${modelName} by${req.session.user.username}`);
        res.redirect('/admin-database');
    } catch (err) {
        console.error("Error deleting record:", err);
        res.status(500).send("Error deleting record");
    }
});

// Clear/Wipe an entire collection
app.post('/admin/database/:modelName/clear', isAdmin, async (req, res) => {
    try {
        const { modelName } = req.params;
        const model = mongoose.model(modelName);
        await model.deleteMany({});

        console.log(`[Admin DB] WARNING: Collection ${modelName} was completely wiped by${req.session.user.username}`);
        res.redirect('/admin-database');
    } catch (err) {
        console.error("Error clearing collection:", err);
        res.status(500).send("Error clearing collection");
    }
});

// Discord Login Route
app.get('/auth/discord', (req, res) => {
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(discordAuthUrl);
});

// Discord Callback & Token Exchange (Guaranteed Connection & Return Document)
app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    try {
        await connectDB();

        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: process.env.DISCORD_REDIRECT_URI,
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const { access_token } = tokenResponse.data;

        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${access_token}` }
        });

        const discordUser = userResponse.data;
        const currentDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        await User.findOneAndUpdate(
            { id: discordUser.id },
            {
                $set: {
                    username: discordUser.username,
                    avatar: discordUser.avatar,
                    lastActive: new Date()
                },
                $setOnInsert: {
                    whitelistStatus: 'Pending Review',
                    department: 'Unassigned',
                    callsign: 'Unassigned',
                    strikes: 0,
                    submittedDate: currentDate
                }
            },
            { upsert: true, returnDocument: 'after' }
        );

        req.session.user = discordUser;
        req.session.save(() => {
            res.redirect('/dashboard');
        });
    } catch (error) {
        console.error('Discord Auth Fatal Error:', error.response?.data || error.message);
        res.redirect('/');
    }
});

// Render Application Form
app.get('/apply', async (req, res) => {
    if (!req.session.user) return res.redirect('/');

    try {
        const dbUser = await User.findOne({ id: req.session.user.id });
        res.render('apply', { user: req.session.user, dbUser });
    } catch (err) {
        console.error('Error loading application page:', err);
        res.status(500).send('Server Error');
    }
});

// Handle Application Submission
app.post('/apply', async (req, res) => {
    if (!req.session.user) return res.redirect('/');

    try {
        const {
            irl_name,
            irl_age_bday,
            rp_name,
            rp_age,
            rp_address,
            rp_description,
            rp_story,
            joined_rp,
            fivem_time,
            previous_servers,
            about_yourself,
            interests
        } = req.body;

        const formattedInterests = Array.isArray(interests) ? interests : (interests ? [interests] : []);
        const currentDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        const existingUser = await User.findOne({ id: req.session.user.id });
        const updateData = {
            irl_name: irl_name ? irl_name.trim() : '',
            irl_age_bday: irl_age_bday ? irl_age_bday.trim() : '',
            rp_name: rp_name ? rp_name.trim() : '',
            rp_age: parseInt(rp_age) || 0,
            rp_address: rp_address ? rp_address.trim() : '',
            rp_description: rp_description ? rp_description.trim() : '',
            rp_story: rp_story ? rp_story.trim() : '',
            joined_rp: joined_rp ? joined_rp.trim() : '',
            fivem_time: fivem_time ? fivem_time.trim() : '',
            previous_servers: previous_servers ? previous_servers.trim() : '',
            about_yourself: about_yourself ? about_yourself.trim() : '',
            interests: formattedInterests,
            submittedDate: currentDate
        };

        if (!existingUser || existingUser.whitelistStatus !== 'Approved') {
            updateData.whitelistStatus = 'Pending Review';
        }

        await User.findOneAndUpdate(
            { id: req.session.user.id },
            { $set: updateData },
            { upsert: true, returnDocument: 'after' }
        );

        sendImportantLog(
            'New Application Submitted',
            `User **${req.session.user.username}** has submitted or updated their whitelist application.`,
            0x3b82f6,
            [
                { name: 'User ID', value: `\`${req.session.user.id}\``, inline: true },
                { name: 'RP Name', value: rp_name || 'Not Provided', inline: true }
            ]
        );

        res.redirect('/dashboard');
    } catch (err) {
        console.error('Error submitting application:', err);
        res.status(500).send('Server Error saving application');
    }
});

// Render user details in a printable PDF-friendly view
app.get('/admin/user/:id/pdf', isAdmin, async (req, res) => {
    try {
        const targetUser = await User.findOne({ id: req.params.id }).lean();
        if (!targetUser) {
            return res.status(404).render('error', { message: 'User record not found.' });
        }

        res.render('admin-user-pdf', {
            user: req.session.user,
            targetUser
        });
    } catch (err) {
        console.error('Error loading user PDF view:', err);
        res.status(500).send('Server Error');
    }
});

// POST /admin/send-notification
app.post('/admin/send-notification', isAdmin, async (req, res) => {
    try {
        const { sendTo, recipientId, notificationType, title, description } = req.body;

        const newNotification = new Notification({
            type: notificationType || 'info',
            title: title,
            message: description || title,
            createdBy: req.session.user ? req.session.user.username : 'System Admin',
            date: new Date(),
            read: false
        });

        await newNotification.save();

        if (sendTo === 'all') {
            await User.updateMany({}, { $push: { notifications: newNotification._id } });
            console.log('Broadcasting notification to all members:', title);
        } else if (sendTo === 'individual' && recipientId) {
            await User.updateOne({ id: recipientId }, { $push: { notifications: newNotification._id } });
            console.log(`Sending notification to user ${recipientId}:`, title);
        }

        res.redirect('/admin?success=NotificationSent');
    } catch (err) {
        console.error('Error sending notification:', err);
        res.status(500).send('Server Error while sending notification.');
    }
});

app.get('/api/discord-widget', async (req, res) => {
    try {
        const serverId = '1547446391901528154';
        const response = await axios.get(`https://discord.com/api/guilds/${serverId}/widget.json`);
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch Discord widget' });
    }
});

// Protected Dashboard Route
app.get('/dashboard', async (req, res) => {
    if (!req.session.user) return res.redirect('/');

    let userRoles = [];
    const userId = req.session.user.id;
    const guildId = process.env.DISCORD_GUILD_ID;
    const botToken = process.env.DISCORD_BOT_TOKEN;

    try {
        const response = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
            headers: { Authorization: `Bot ${botToken}` }
        });

        const memberRoleIds = response.data.roles;

        const rolesResponse = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
            headers: { Authorization: `Bot ${botToken}` }
        });

        const guildRoles = rolesResponse.data;

        userRoles = guildRoles
            .filter(role => memberRoleIds.includes(role.id) && role.name !== '@everyone')
            .map(role => ({ name: role.name, color: role.color }));

    } catch (error) {
        console.error('Failed to fetch Discord roles for user:', error.response?.data || error.message);
        userRoles = [{ name: 'Not in Guild', color: 0 }];
    }

    const userData = {
        ...req.session.user,
        roles: userRoles
    };

    res.render('dashboard', { user: userData });
});

app.get('/api/check-guild-membership', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.session.user.id;
    const guildId = process.env.DISCORD_GUILD_ID;
    const botToken = process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TOKEN;

    if (!guildId || !botToken) {
        return res.status(500).json({ error: 'Server configuration missing' });
    }

    try {
        const response = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
            headers: { Authorization: `Bot ${botToken}` }
        });

        if (response.status === 200) {
            return res.json({ inGuild: true });
        } else {
            return res.json({ inGuild: false });
        }
    } catch (err) {
        if (err.response && err.response.status === 404) {
            return res.json({ inGuild: false });
        }
        console.error('Failed to check guild membership via bot:', err.message);
        return res.json({ inGuild: true });
    }
});

// Logout Route
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// Server / Vercel Export Setup
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`[UPN Server] Running locally on http://localhost:${PORT}`);
    });
}

module.exports = app;