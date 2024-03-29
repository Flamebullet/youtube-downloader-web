const dotenv = require('dotenv');
dotenv.config();

module.exports = {
	spotifyId: process.env.SPOTIFYID,
	spotifySecret: process.env.SPOTIFYSECRET,
	databaseUrl: process.env.DATABASE_URL
};
