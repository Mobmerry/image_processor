'use strict';

const fs	= require('fs');
const im	= require('imagemagick');
const AWS = require('aws-sdk');

// INCREASE LAMBDA FUNCTION TIMEOUT

const mimeTypes = {
	'image/jpeg': 'jpeg',
	'image/png': 'png',
	'image/gif': 'gif'
}

const versions = [
	{
		name: 'thumb',
		width: 100,
		height: 100
	},
	{
		name: 'web',
		width: 225,
		height: null
	},
	{
		name: 'web_mob',
		width: 280,
		height: null
	},
	{
		name: 'ldpi',
		width: 290,
		height: null
	},
	{
		name: 'mdpi',
		width: 420,
		height: null
	},
	{
		name: 'hdpi',
		width: 520,
		height: null
	},
	{
		name: 'xhdpi',
		width: 630,
		height: null
	},
	{
		name: 'xxhdpi',
		width: 1062,
		height: null
	}
];

const s3 = new AWS.S3();

const identify = (tmpFile, callback) => {
	im.identify(tmpFile, (err, output) => {
		if (err) {
			console.log('Identify operation failed:', err);
			callback(err, null);
		} else {
			console.log('Identify operation completed successfully');
			callback(null, output);
		}
	});
};

const resize = (args, callback) => {
	return new Promise((callback) => {
		im.resize(args, (err) => {
			if (err) {
				console.log('Resize operation failed:', err);
				callback(err, null);
			} else {
				console.log('Resize operation completed successfully');
				callback(null, true);
			}
		});
	});
};

const convert = (req, callback) => {
	const customArgs = req.customArgs || [];
	let inputFile = null;
	let outputFile = null;

	if (req.base64Image) {
		inputFile		= `/tmp/inputFile.${(req.inputExtension || 'png')}`;
		const buffer = new Buffer(req.base64Image, 'base64');

		fs.writeFileSync(inputFile, buffer);
		customArgs.unshift(inputFile);
	}

	if (req.outputExtension) {
		outputFile = `/tmp/outputFile.${req.outputExtension}`;
		customArgs.push(outputFile);
	}

	im.convert(customArgs, (err, output) => {
		if (err) {
			console.log('Convert operation failed:', err);
			callback(err);
		} else {
			console.log('Convert operation completed successfully');
			postProcessResource(inputFile);

			if (outputFile) {
				callback(null, postProcessResource(outputFile, (file) => new Buffer(fs.readFileSync(file)).toString('base64')));
			} else {
				// Return the command line output as a debugging aid
				callback(null, output);
			}
		}
	});
};

const calculateQualitySetting = (currentQuality) => {
	currentQuality = parseFloat(currentQuality);

	return (currentQuality <= 0.75) ? 1.0 : (0.75 + (1.0 - currentQuality));
}

const postProcess = (err, status) => {
	if (err == null) {
		console.log('Success: ', status);
		return true;
	} else {
		console.log('Error: ', err);
		throw new Error(err);
	}
}

const uploadToS3 = (bucket, fileVersion, callback) => {
	return new Promise((callback) => {
		let data = null;

		try {
			data = fs.readFile(fileVersion.filePath, (err, data) => {
				let params = {
					Bucket: bucket,
					Key: fileVersion.objectKey,
					ACL: 'public-read',
					Body: data,
					CacheControl: 'max-age=31536000',
					Expires: new Date((new Date().getTime()) + 7 * 24 * 60 * 60 * 1000),
					ContentType: 'image/jpeg',
				};

				s3.putObject(params, (err, data) => {
					if (err) {
						console.error('S3 upload failed: ', fileVersion.fileName);
						callback(err, null);
					} else {
						console.log('S3 upload successfully: ', fileVersion.fileName);
						callback(null, true);
					}
				});
			});
		} catch (err) {
      callback(err, null);
		} finally {
			fs.unlink(fileVersion.filePath, (err) => {
			  if (err) {
					console.log('Error while deleting file: ', fileVersion.filePath);
				};
			});
		}
	});
}

exports.handler = (event, context) => {
	// Get the object from the event and show its content type
	let bucket		= event.Records[0].s3.bucket.name;
	let objectKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));

	let params = {
		Bucket: bucket,
		Key: objectKey,
	};

	s3.getObject(params, (err, data) => {
		if (err) {
			console.log(err);
			context.done(event, context);
		} else {
			console.log('CONTENT TYPE:', data.ContentType.toLowerCase());

			if (!Object.keys(mimeTypes).includes(data.ContentType.toLowerCase())) {
				console.log(err);
				context.done(event, context);
			}

			let splittedObjectKey = objectKey.split("/");
			let [fileName, fileExtension] = splittedObjectKey.pop().split(".");
			let s3BasePath = splittedObjectKey.join("/");

			console.log('fileName: ', fileName);
			console.log('fileExtension: ', fileExtension);

			let tmpFile = `/tmp/${fileName}.${fileExtension}`;
			fs.writeFileSync(tmpFile, data.Body);

			identify(tmpFile, (err, output) => {
				if (err) {
					console.log(err);
					context.done(event, context);
				} else {
					let quality = calculateQualitySetting(output['quality']);
					let jobs		= [];

					console.log('Quality Setting: ', quality);

					for (let version of versions) {
						let versionFileName = `${version.name}_${fileName.split('_').pop()}.${fileExtension}`;
						let dstPath         = `/tmp/${versionFileName}`;

						version.filePath  = dstPath;
						version.fileName  = versionFileName;
						version.objectKey = `${s3BasePath}/${versionFileName}`;

						let args = {
							srcPath: tmpFile,
							dstPath: dstPath,
							quality: quality,
							format: 'jpg',
							progressive: true,
							width: version.width,
							strip: false,
							customArgs: ['+profile', '!icc,!xmp,*'],
						};

						if (version.height != null) {
							args.height = version.height;
						}

						let p = resize(args, postProcess);
						jobs.push(p);
					}

					Promise.all(jobs).then(values => {
						console.log(values);
						jobs = [];

						for (let version of versions) {
							let p = uploadToS3(bucket, version, postProcess);
							jobs.push(p);
            }

						Promise.all(jobs).then(values => {
							console.log(values);
							// Push to SQS queue
							context.done();
						}).catch(reason => {
							console.log(reason);
							context.done(event, context);
						});
					}).catch(reason => {
						console.log(reason);
						context.done(event, context);
					});
				}
			});
		}
	});
};
