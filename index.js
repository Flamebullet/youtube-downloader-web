const express = require('express');
const https = require('https');
const path = require('path');
const app = express();
// Downloading/file management modules
const ytdl = require('ytdl-core');
const fs = require('fs');
const cp = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { Client } = require('youtubei');
const youtube = new Client();
const { spotifyId, spotifySecret } = require('./cred.js');
const spotifyInfo = require('spotify-info');
spotifyInfo.setApiCredentials(spotifyId, spotifySecret);

// progress bar object
const progbarobj = {};

// Code to serve images
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function throwError(res, err) {
	return res.redirect(`/error?err=${err}`);
}

function secToStr(sec) {
	if (sec === null || sec === undefined) return '0:00';

	totalSeconds = sec;
	let hours = Math.floor(totalSeconds / 3600).toLocaleString('en-US', {
		minimumIntegerDigits: 2,
		useGrouping: false
	});
	totalSeconds %= 3600;
	let minutes = Math.floor(totalSeconds / 60).toLocaleString('en-US', {
		minimumIntegerDigits: 2,
		useGrouping: false
	});
	let seconds = (sec % 60).toLocaleString('en-US', {
		minimumIntegerDigits: 2,
		useGrouping: false
	});

	return `${hours}:${minutes}:${seconds}`.replace(/^(?:00:)?0?/, '');
}

// OUR ROUTES WILL GO HERE
const key = fs.readFileSync(`${__dirname}\\certs\\key.pem`);
const cert = fs.readFileSync(`${__dirname}\\certs\\cert.pem`);
const server = https.createServer({ key: key, cert: cert }, app);

const port = 443;
server.listen(port, () => {
	console.log(`Server is running on https://localhost:${port}`);
});

// app.listen(3000, () => {
// 	console.log('Server is running on http://localhost:3000');
// });

// home page
app.get('/', (req, res) => {
	const err = req.query.err ? req.query.err : null;

	return res.render('index', { err: err });
});

// search page
app.get('/search', async (req, res) => {
	const { url, video, audio } = req.query;
	let results;

	await youtube
		.search(url, { type: 'video' })
		.then(async (r) => {
			if (r.length === 0) return res.redirect(`/?err=${encodeURIComponent(`No videos found from "${url}"`)}`);

			results = r.items;
			for (var result of results) {
				result.client = null;
				result.thumbnail = result.thumbnails[0].url;
				result.thumbnails = null;
				result.channel.client = null;
				result.channel.shorts = null;
				result.channel.live = null;
				result.channel.videos = null;
				result.channel.playlists = null;
				result.url = `https://www.youtube.com/watch?v=${result.id}`;
				result.timestamp = secToStr(result.duration);
			}

			return res.render('search', { JSONresults: encodeURIComponent(JSON.stringify({ results })), results: results, video: video, audio: audio });
		})
		.catch(async (err) => {
			console.log(err);
			return res.redirect(`/?err=${encodeURIComponent(err)}`);
		});
	return;
});

// Select quality page
app.get('/download', async (req, res) => {
	let title, video_id, videoFormats;
	const videoSelect = req.query.video ? req.query.video : 'off';
	const audioSelect = req.query.audio ? req.query.audio : 'off';
	let { url } = req.query;
	const { videoItag, dl, uid } = req.query;

	if (url == '') return res.redirect(`/?err=${encodeURIComponent('URL cannot be empty')}`);
	if (videoSelect == 'off' && audioSelect == 'off')
		return res.redirect(`/?err=${encodeURIComponent('Please select a video or audio format')}&url=${encodeURIComponent(url)}`);

	if (spotifyInfo.validateTrackURL(url)) {
		try {
			let track = await spotifyInfo.getTrack(url);

			await youtube.search(`${track.name} ${track.artists[0].name}`, { type: 'video' }).then(async (r) => {
				let durationList = [];
				const goal = Math.round(track.duration / 1000);
				r.items.map((v) => durationList.push(v.duration));
				var closest = durationList.reduce(function (prev, curr) {
					return Math.abs(curr - goal) < Math.abs(prev - goal) ? curr : prev;
				});

				for (const song of r.items) {
					if (song.duration == closest) {
						url = `https://www.youtube.com/watch?v=${song.id}`;
						break;
					}
				}
			});
		} catch (err) {
			console.log(err);
			return res.redirect(`/?err=${encodeURIComponent('Invalid Spotify Track URL entered!')}`);
		}
	}

	try {
		// Create the video quality selection dropdown menu
		const video = await ytdl.getInfo(url).catch((err) => {
			return res.redirect(`/search?url=${encodeURIComponent(url)}&video=${encodeURIComponent(videoSelect)}&audio=${encodeURIComponent(audioSelect)}`);
		});
		if (!video) return;

		const videoDetails = video.videoDetails;

		if (videoDetails.isLiveContent || videoDetails.isLive)
			return res.redirect(`/?err=${encodeURIComponent('Selected video is a live stream, please select a different video.')}`);

		async function downloadVideo(videoItag, videoDetails) {
			const tracker = {
				start: Date.now(),
				audio: { downloaded: 0, total: Infinity },
				video: { downloaded: 0, total: Infinity },
				merged: { frame: 0, speed: '0x', fps: 0 }
			};

			let audio, video;
			if (audioSelect == 'on') {
				audio = ytdl(videoDetails.video_url, {
					filter: 'audioonly',
					quality: 'highestaudio',
					highWaterMark: 1 << 25
				}).on('progress', (_, downloaded, total) => {
					tracker.audio = { downloaded, total };
				});
			}

			if (videoSelect == 'on') {
				video = ytdl(videoDetails.video_url, {
					quality: `${videoItag}`
				}).on('progress', (_, downloaded, total) => {
					tracker.video = { downloaded, total };
				});
			}

			let progressbarHandle = null;
			const progressbarInterval = 1000;
			const showProgress = () => {
				const toMB = (i) => (i / 1024 / 1024).toFixed(2);

				let progress = `Audio  | ${((tracker.audio.downloaded / tracker.audio.total) * 100).toFixed(2)}% processed `;
				progress += `(${toMB(tracker.audio.downloaded)}MB of ${toMB(tracker.audio.total)}MB).${' '.repeat(10)}\n`;

				progress += `Video  | ${((tracker.video.downloaded / tracker.video.total) * 100).toFixed(2)}% processed `;
				progress += `(${toMB(tracker.video.downloaded)}MB of ${toMB(tracker.video.total)}MB).${' '.repeat(10)}\n`;

				progress += `Merged | processing frame ${tracker.merged.frame} `;
				progress += `(at ${tracker.merged.fps} fps => ${tracker.merged.speed}).${' '.repeat(10)}\n\n`;

				progress += `Running for: ${((Date.now() - tracker.start) / 1000 / 60).toFixed(2)} Minutes.`;

				Object.assign(progbarobj, { [uid]: progress });
			};

			let filename;
			if (videoSelect == 'on') {
				filename = `${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')}.mp4`;
			} else {
				filename = `${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')}.mp3`;
			}

			// If file already exist remove the old file
			if (fs.existsSync(filename)) {
				fs.unlink(filename, () => {
					return;
				});
			}
			if (audioSelect == 'on' && videoSelect == 'on') {
				// Start the ffmpeg child process
				const ffmpegProcess = cp.spawn(
					ffmpeg,
					[
						// Remove ffmpeg's console spamming
						'-loglevel',
						'8',
						'-hide_banner',
						// Redirect/Enable progress messages
						'-progress',
						'pipe:3',
						// Set inputs
						'-i',
						'pipe:4',
						'-i',
						'pipe:5',
						// Map audio & video from streams
						'-map',
						'0:a',
						'-map',
						'1:v',
						// Keep encoding
						'-c:v',
						'copy',
						// Define output file
						filename
					],
					{
						windowsHide: true,
						stdio: [
							/* Standard: stdin, stdout, stderr */
							'inherit',
							'inherit',
							'inherit',
							/* Custom: pipe:3, pipe:4, pipe:5 */
							'pipe',
							'pipe',
							'pipe'
						]
					}
				);

				ffmpegProcess.on('close', async () => {
					clearInterval(progressbarHandle);
					Object.assign(progbarobj, { [uid]: `Done ${encodeURIComponent(filename)}` });
					return res.status(200).json({ file: encodeURIComponent(filename) });
				});

				// Link streams
				// FFmpeg creates the transformer streams and we just have to insert / read data
				ffmpegProcess.stdio[3].on('data', (chunk) => {
					// Start the progress bar
					if (!progressbarHandle) progressbarHandle = setInterval(showProgress, progressbarInterval);

					// Parse the param=value list returned by ffmpeg
					const lines = chunk.toString().trim().split('\n');
					const args = {};
					for (const l of lines) {
						const [key, value] = l.split('=');
						args[key.trim()] = value.trim();
					}
					tracker.merged = args;
				});

				audio.pipe(ffmpegProcess.stdio[4]);
				video.pipe(ffmpegProcess.stdio[5]);
			} else if (audioSelect == 'on') {
				if (!progressbarHandle) progressbarHandle = setInterval(showProgress, progressbarInterval);
				// output audio as mp3 file
				const ffmpegProcess = cp.spawn(
					ffmpeg,
					[
						// Remove ffmpeg's console spamming
						'-loglevel',
						'8',
						'-hide_banner',
						// Redirect/Enable progress messages
						'-progress',
						'pipe:3',
						// Set inputs
						'-i',
						'pipe:4',
						// Map audio & video from streams
						'-map',
						'0:a',
						'-codec:a',
						'libmp3lame',
						'-qscale:a',
						'0',
						'-y',
						filename
					],
					{
						windowsHide: true,
						stdio: [
							/* Standard: stdin, stdout, stderr */
							'inherit',
							'inherit',
							'inherit',
							/* Custom: pipe:3, pipe:4, pipe:5 */
							'pipe',
							'pipe'
						]
					}
				);

				ffmpegProcess.on('close', async () => {
					clearInterval(progressbarHandle);
					Object.assign(progbarobj, { [uid]: `Done ${encodeURIComponent(filename)}` });
					return res.status(200).json({ file: encodeURIComponent(filename) });
				});

				audio.pipe(ffmpegProcess.stdio[4]);
			} else if (videoSelect == 'on') {
				if (!progressbarHandle) progressbarHandle = setInterval(showProgress, progressbarInterval);
				video.pipe(fs.createWriteStream(filename));
				video.on('end', () => {
					clearInterval(progressbarHandle);
					Object.assign(progbarobj, { [uid]: `Done ${encodeURIComponent(filename)}` });
					return res.status(200).json({ file: encodeURIComponent(filename) });
				});
			}
		}

		if (dl) return downloadVideo(videoItag, videoDetails);

		// if (!video) return;
		function convertNum(num) {
			let result;
			if (num >= 1000000) {
				result = (num / 1000000).toFixed(1) + 'M';
			} else if (num >= 1000) {
				result = (num / 1000).toFixed(1) + 'K';
			} else {
				result = num.toString();
			}
			// Remove .0 from the result
			return result.replace('.0', '');
		}

		// videoDetails.storyboards = null;
		videoDetails.availableCountries = null;
		videoDetails.keywords = null;
		let subscribers = convertNum(videoDetails.author.subscriber_count);

		title = videoDetails.title;

		if (videoSelect == 'on') videoFormats = ytdl.filterFormats(video.formats, 'videoonly');

		return res.render('download', {
			url: video.videoDetails.embed.iframeUrl,
			title: title,
			author: encodeURIComponent(JSON.stringify(videoDetails.author)),
			subscribers: subscribers,
			verified: videoDetails.author.verified,
			videoFormats: videoFormats,
			videoSelect: videoSelect,
			audioSelect: audioSelect,
			videoDetails: encodeURIComponent(JSON.stringify(videoDetails))
		});
	} catch (err) {
		throwError(res, err);
	}
});

// Download page
app.get('/download/download', async function (req, res) {
	const file = decodeURIComponent(req.query.file);

	res.download(file, async (err) => {
		fs.unlink(file, () => {
			return;
		});
	});
});

app.get('/download/progress', async function (req, res) {
	const { uid } = req.query;

	const progress = progbarobj[uid] ? progbarobj[uid] : ' ';

	if (progress.startsWith('Done')) {
		delete progbarobj[uid];
	}

	return res.status(200).json({ progress: progress });
});

// error page
app.get('/error', (req, res) => {
	return res.render('error', { err: req.query.err });
});
