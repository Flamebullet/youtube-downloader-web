const express = require('express');
const path = require('path');
const app = express();
const url = require('url');
// Downloading/file management modules
const ytdl = require('ytdl-core');
const fs = require('fs');
const cp = require('child_process');
const ffmpeg = require('ffmpeg-static');

// Code to serve images
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function throwError(res, err) {
	return res.redirect(`/error?err=${err}`);
}

// OUR ROUTES WILL GO HERE
app.listen(3000, () => {
	console.log('Server is running on http://localhost:3000');
});

// home page
app.get('/', (req, res) => {
	const err = req.query.err ? req.query.err : null;

	return res.render('index', { err: err });
});

// Select quality page
app.get('/select', async (req, res) => {
	let title, video_id, videoFormats;
	const videoSelect = req.query.video ? req.query.video : 'off';
	const audioSelect = req.query.audio ? req.query.audio : 'off';
	const { url, videoItag, dl } = req.query;

	try {
		// Create the video quality selection dropdown menu
		const video = await ytdl.getInfo(url).catch((err) => {
			return res.redirect(`/?err=${encodeURIComponent('Unable to get information for this video, try again or try another video')}`);
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
				});
			}

			if (videoSelect == 'on') {
				video = ytdl(videoDetails.video_url, {
					quality: `${videoItag}`
				});
			}

			let filename;
			if (videoSelect == 'on') {
				filename = `${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')}.mp4`;
			} else {
				filename = `${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')}.mp3`;
			}

			if (fs.existsSync(filename)) {
				let i = 1;
				while (fs.existsSync(filename)) {
					videoSelect == 'on'
						? (filename = `${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')} (${i}).mp4`)
						: (filename = `${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')} (${i}).mp3`);
					i++;
				}
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
					return res.status(200).json({ file: encodeURIComponent(filename) });
				});

				// Link streams
				// FFmpeg creates the transformer streams and we just have to insert / read data
				ffmpegProcess.stdio[3].on('data', (chunk) => {
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
					return res.status(200).json({ file: encodeURIComponent(filename) });
				});

				audio.pipe(ffmpegProcess.stdio[4]);
			} else if (videoSelect == 'on') {
				video.pipe(fs.createWriteStream(filename));
				video.on('end', () => {
					return res.status(200).json({ file: encodeURIComponent(filename) });
				});
			}
		}

		if (dl) {
			return downloadVideo(videoItag, video.videoDetails);
		}

		if (!video) return;

		title = videoDetails.title;

		if (videoSelect == 'on') videoFormats = ytdl.filterFormats(video.formats, 'videoonly');

		return res.render('select', {
			url: video.videoDetails.embed.iframeUrl,
			title: title,
			videoFormats: videoFormats,
			videoSelect: videoSelect,
			audioSelect: audioSelect,
			videoDetails: videoDetails
		});
	} catch (err) {
		throwError(res, err);
	}
});

// Download page
app.get('/select/download', async function (req, res, next) {
	const file = decodeURIComponent(req.query.file);

	res.download(file, async (err) => {
		fs.unlink(file, () => {
			return;
		});
	});
});

// error page
app.get('/error', (req, res) => {
	return res.render('error', { err: req.query.err });
});
