const dotenv = require('dotenv');
dotenv.config();

module.exports = {
	spotifyId: process.env.SPOTIFYID,
	spotifySecret: process.env.SPOTIFYSECRET
};
