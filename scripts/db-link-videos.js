/**
 * db-link-videos.js — Direct DB insert of video links for Batch 1
 *
 * Videos are already uploaded to R2. This script only inserts
 * exercise_videos rows and updates exercices.has_video.
 *
 * Extracted from batch-video-import.js output log.
 * Run: DATABASE_URL=<clever_cloud_url> node scripts/db-link-videos.js
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const DB_URL = process.env.CLEVER_CLOUD_DB_URL || process.env.DATABASE_URL;
if (!DB_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }

const pool = new Pool({ connectionString: DB_URL });

// admin kine id (uploaded_by NOT NULL constraint)
const UPLOADED_BY = 2;

// Extracted from batch-video-import.js output — all videos on R2 CDN
// Format: { exercise_ids, video_url, thumbnail_url, source_name, source_url }
const LINKS = [
  // [1/41] Pixabay - Neck Stretching Athlete
  {
    exercise_ids: [39, 40, 44, 200],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/d5795e6a-49f0-4577-9e85-5a6204584e35.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/30368c3b-1366-4ff5-98bf-b1dd822b9ff9.jpg',
    source_name: 'Pixabay - Neck Stretching Athlete',
    source_url: 'https://pixabay.com/videos/workout-athlete-sports-training-189729/',
  },
  // [2/41] Pixabay - Yoga Neck Concentration
  {
    exercise_ids: [41, 202],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/49b2565b-aaaf-4d32-ae25-fc19a475b88d.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/7f97e42c-4292-4203-b9e8-e75645b60215.jpg',
    source_name: 'Pixabay - Yoga Neck Concentration',
    source_url: 'https://pixabay.com/videos/woman-yoga-exercise-concentration-129423/',
  },
  // [3/41] Pixabay - Neck Strengthening Training
  {
    exercise_ids: [42, 201],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/914efefa-3e18-4ceb-a4eb-c3d4d4019dc6.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/24e3a120-c73c-47e5-802f-92c509ac5a3e.jpg',
    source_name: 'Pixabay - Neck Strengthening Training',
    source_url: 'https://pixabay.com/videos/workout-athlete-sports-training-189730/',
  },
  // [4/41] Pixabay - Meditation Yoga Neck
  {
    exercise_ids: [43, 59, 62],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/fa74f865-2383-4376-8f31-a01e2a1550ec.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/32d6669f-1229-428b-953b-a84e28d6c628.jpg',
    source_name: 'Pixabay - Meditation Yoga Neck',
    source_url: 'https://pixabay.com/videos/woman-yoga-exercise-concentration-129425/',
  },
  // [5/41] Pixabay - Senior Stretching Exercise
  {
    exercise_ids: [60, 61],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/e90ad63b-ec26-465a-a99c-e2eeca523e58.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/5bde66dd-56ff-4b61-83b6-ce4b7a4038ea.jpg',
    source_name: 'Pixabay - Senior Stretching Exercise',
    source_url: 'https://pixabay.com/videos/exercise-stretching-senior-elder-32937/',
  },
  // [6/41] Pixabay - Yoga Health Exercise Woman
  {
    exercise_ids: [63],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/d057a7ab-4876-4e9f-85d2-5d8c8754e740.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/a8a02204-aa69-49bf-93d7-de94492a09ff.jpg',
    source_name: 'Pixabay - Yoga Health Exercise Woman',
    source_url: 'https://pixabay.com/videos/yoga-health-exercise-woman-fitness-445/',
  },
  // [7/41] Pixabay - Neck McKenzie Training
  {
    exercise_ids: [140],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/deadbdc3-59cf-49a4-80d0-a68210d64ce7.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/faae9d08-78b1-4303-8401-0e42148259d9.jpg',
    source_name: 'Pixabay - Neck McKenzie Training',
    source_url: 'https://pixabay.com/videos/workout-athlete-sports-training-189731/',
  },
  // [8/41] Pixabay - Home Exercise Workout
  {
    exercise_ids: [141],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/53329518-2a91-4668-b1d9-fb2623d8c9f7.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/abe77a04-be0b-4bab-ae8f-27b8fa9294f7.jpg',
    source_name: 'Pixabay - Home Exercise Workout',
    source_url: 'https://pixabay.com/videos/exercise-home-workout-fitness-35009/',
  },
  // [9/41] Pixabay - Shoulder Meditation Pose
  {
    exercise_ids: [1, 193],
    // exercise 228 was skipped (not found)
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/d6a3cd4b-4d38-4c64-8e6c-b84de5ca8056.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/18efa6ce-b949-4168-8149-bd90824293fa.jpg',
    source_name: 'Pixabay - Shoulder Meditation Pose',
    source_url: 'https://pixabay.com/videos/yoga-meditation-relax-woman-124251/',
  },
  // [10/41] Pixabay - Exercise Fitness Lifestyle
  {
    exercise_ids: [2],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/2b5e88e6-d32f-468a-b63a-6463034d290e.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/2db05674-1aa8-404c-b895-54f870a6d100.jpg',
    source_name: 'Pixabay - Exercise Fitness Lifestyle',
    source_url: 'https://pixabay.com/videos/exercise-fitness-sport-lifestyle-32934/',
  },
  // [11/41] Pixabay - Shoulder Rotation Gym
  {
    exercise_ids: [3],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/2e3ce3dc-2553-485d-9d3c-6e141defc5aa.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/f6fc5ba5-a55e-47c6-9131-0da094751a0d.jpg',
    source_name: 'Pixabay - Shoulder Rotation Gym',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148208/',
  },
  // [12/41] Pixabay - Shoulder Capsule Stretch
  {
    exercise_ids: [4, 194],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/5941bfc6-6968-4720-8c62-f7733896c92d.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/6f49dda2-f818-4e62-a3f5-058fd6f71f7b.jpg',
    source_name: 'Pixabay - Shoulder Capsule Stretch',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-exercise-135157/',
  },
  // [13/41] Pixabay - Resistance Band Shoulder
  {
    exercise_ids: [5, 64],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/d14856f1-b44a-4799-a339-12d1478bdc1a.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/7503dff8-cdc4-46ec-a52d-3b193d5cacc3.jpg',
    source_name: 'Pixabay - Resistance Band Shoulder',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148212/',
  },
  // [14/41] Pixabay - Shoulder Circumduction Gym
  {
    exercise_ids: [6],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/e233e45c-0572-4c15-9fe2-8e83e5ce0f48.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/a2de7dce-5862-45af-9885-cd1e2e2b0430.jpg',
    source_name: 'Pixabay - Shoulder Circumduction Gym',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-exercise-135156/',
  },
  // [15/41] Pixabay - Lateral Raise Resistance
  {
    exercise_ids: [7],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/b29c26de-bf84-45df-898f-89cabdd4e7d8.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/bfe77a7c-dbc7-4d89-960b-99e9d88abf92.jpg',
    source_name: 'Pixabay - Lateral Raise Resistance',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148196/',
  },
  // [16/41] Pixabay - Scapular YTW Strengthening
  {
    exercise_ids: [65, 66, 67],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/fac4d3f8-7fdd-4a69-9157-f2e796c81d7c.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/64ae3756-dbf4-41dd-9798-8136bc2fa929.jpg',
    source_name: 'Pixabay - Scapular YTW Strengthening',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148203/',
  },
  // [17/41] Pixabay - Wall Slide Scapular Gym
  {
    exercise_ids: [68],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/68f0cf4f-0efa-4d5b-8449-a80ee6b8ec91.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/4cc30d34-f2bc-4f03-9291-b2a97a60c219.jpg',
    source_name: 'Pixabay - Wall Slide Scapular Gym',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148204/',
  },
  // [18/41] Pixabay - Pulley Shoulder Capsulitis
  {
    exercise_ids: [69],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/02bc8f72-eacc-4f08-a72d-e8e3d8ef449c.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/2c06c417-1300-4701-997a-377f4f290529.jpg',
    source_name: 'Pixabay - Pulley Shoulder Capsulitis',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148197/',
  },
  // [19/41] Pixabay - Shoulder Stretch Rotation
  {
    exercise_ids: [70, 142],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/4fdd78d8-203c-44fe-87ad-748b33b035ef.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/68fd94c8-a8c3-4ea6-9a3d-03edd74c500b.jpg',
    source_name: 'Pixabay - Shoulder Stretch Rotation',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-exercise-135160/',
  },
  // [20/41] Pixabay - Resistance Band Rowing
  {
    exercise_ids: [71],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/fd7aa160-8882-4515-aee5-913bb28bed46.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/1e59ea0c-d12a-43c1-bef3-27d8b1126168.jpg',
    source_name: 'Pixabay - Resistance Band Rowing',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148201/',
  },
  // [21/41] Pixabay - Shoulder Shrug Gym
  {
    exercise_ids: [143],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/43fa6b0a-4415-42c3-a0eb-9daba4eef9f0.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/4b6688d4-ba4c-41e6-b261-69c5f8715c02.jpg',
    source_name: 'Pixabay - Shoulder Shrug Gym',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148202/',
  },
  // [22/41] Pixabay - Dumbbell Rotation Exercise
  {
    exercise_ids: [192],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/32330218-f7e7-4c26-af24-a90f8f948124.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/2586ac49-bf04-4eba-ace0-7dd92ac7b438.jpg',
    source_name: 'Pixabay - Dumbbell Rotation Exercise',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-exercise-135162/',
  },
  // [23/41] Pixabay - Push-Up Plus Serratus
  {
    exercise_ids: [195],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/fa6d8f79-f305-416b-b415-d1a02ad91652.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/ac19779f-72dd-4a36-b717-e8e45b240c27.jpg',
    source_name: 'Pixabay - Push-Up Plus Serratus',
    source_url: 'https://pixabay.com/videos/pushups-fitness-exercise-work-out-143431/',
  },
  // [24/41] Pixabay - Forearm Eccentric Kettlebell
  {
    exercise_ids: [97, 174],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/5a40ee6c-9c7f-4fff-8392-ab4e25308c20.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/4f6201df-57b5-4669-9cc0-0e11328bf3cd.jpg',
    source_name: 'Pixabay - Forearm Eccentric Kettlebell',
    source_url: 'https://pixabay.com/videos/kettlebell-training-kettlebells-12697/',
  },
  // [25/41] Pixabay - Forearm Stretch Gym
  {
    exercise_ids: [98, 154],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/3e904e72-f2ef-4713-85c4-0d668f7fca58.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/c87e8e62-5197-40e8-8aa0-e2616b137cc8.jpg',
    source_name: 'Pixabay - Forearm Stretch Gym',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148211/',
  },
  // [26/41] Pixabay - Tyler Twist FlexBar Rehab
  {
    exercise_ids: [99],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/afe68af5-2445-4b46-9017-8ee459432eae.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/8f14ca20-00b0-4271-8459-12bb27418829.jpg',
    source_name: 'Pixabay - Tyler Twist FlexBar Rehab',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148199/',
  },
  // [27/41] Pixabay - Supination Pronation Forearm
  {
    exercise_ids: [100, 176],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/be42d7c1-d2da-45d4-9b42-44f939230f6b.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/455331f9-b655-40f9-b759-2ecf456e5706.jpg',
    source_name: 'Pixabay - Supination Pronation Forearm',
    source_url: 'https://pixabay.com/videos/workout-athlete-sports-training-189729/',
  },
  // [28/41] Pixabay - Grip Strength Training
  {
    exercise_ids: [101],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/b2cf88a5-7ce4-4753-b712-1ae30a6f91de.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/051008ef-df55-463e-b8c6-006a31bab0ed.jpg',
    source_name: 'Pixabay - Grip Strength Training',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-149709/',
  },
  // [29/41] Pixabay - Elbow Flexion Extension
  {
    exercise_ids: [102, 173],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/48d2ff99-f9db-4754-8859-8b1f977b5b5b.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/26766e6e-b878-4fbb-9dab-19b803513b31.jpg',
    source_name: 'Pixabay - Elbow Flexion Extension',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148210/',
  },
  // [30/41] Pixabay - Bicep Curl Kettlebell
  {
    exercise_ids: [103],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/d1deb3b3-bb84-4dfe-9b2f-42b164c7ab70.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/41a2930c-cc5b-4ce7-b218-1ea1208db08b.jpg',
    source_name: 'Pixabay - Bicep Curl Kettlebell',
    source_url: 'https://pixabay.com/videos/kettlebell-training-21180/',
  },
  // [31/41] Pixabay - Triceps Extension Kettlebell
  {
    exercise_ids: [104],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/228fa855-256d-41bc-bd6e-472db6bdfa49.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/219fb7ac-18df-4907-b87f-b33b6a7e0a6d.jpg',
    source_name: 'Pixabay - Triceps Extension Kettlebell',
    source_url: 'https://pixabay.com/videos/kettlebell-training-12740/',
  },
  // [32/41] Pixabay - Elbow Rehab Eccentric
  {
    exercise_ids: [155],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/83c40736-e2a6-49fa-a0cd-1e760a074121.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/6403c617-a0fd-47d3-87cd-6f1a430af846.jpg',
    source_name: 'Pixabay - Elbow Rehab Eccentric',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148211/',
  },
  // [33/41] Pixabay - Nerve Gliding Median
  {
    exercise_ids: [175],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/3c10da67-4ff2-4391-be35-09c95c91efb2.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/1713eba0-c01e-4955-8a41-96768eef4f7d.jpg',
    source_name: 'Pixabay - Nerve Gliding Median',
    source_url: 'https://pixabay.com/videos/sport-stretching-people-34972/',
  },
  // [34/41] Pixabay - Wrist Flexion Extension Deviation
  {
    exercise_ids: [34, 38],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/6156d7b9-39eb-43b2-8b2e-ebdcd20bcf03.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/a768e6cb-62fe-4fdc-8c2c-031aa246e972.jpg',
    source_name: 'Pixabay - Wrist Flexion Extension Deviation',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148199/',
  },
  // [35/41] Pixabay - Wrist Pronation Supination
  {
    exercise_ids: [35],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/f3359200-7a7e-4e16-aa82-8e0b2636f108.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/4f684899-e2f2-4287-b3ba-75b747e23d4e.jpg',
    source_name: 'Pixabay - Wrist Pronation Supination',
    source_url: 'https://pixabay.com/videos/workout-athlete-sports-training-189731/',
  },
  // [36/41] Pixabay - Wrist Stretch Senior
  {
    exercise_ids: [36, 106],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/274066da-00ff-4d26-bd30-cca6a79b0bc1.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/0a9042a8-91e3-47d3-9ff8-57c707ea5cec.jpg',
    source_name: 'Pixabay - Wrist Stretch Senior',
    source_url: 'https://pixabay.com/videos/exercise-stretching-senior-elder-32937/',
  },
  // [37/41] Pixabay - Grip Thenar Strength
  {
    exercise_ids: [37, 179],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/0bb0ace2-3e54-49fe-8b6b-3f7cab17d585.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/53b8625b-1aea-4749-aec2-536fbe198521.jpg',
    source_name: 'Pixabay - Grip Thenar Strength',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148201/',
  },
  // [38/41] Pixabay - Nerve Tendon Gliding
  {
    exercise_ids: [105, 178],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/132dde25-9263-43dd-ba68-012dd0895796.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/285723d8-6dd0-4418-a01e-42dd2d26a6be.jpg',
    source_name: 'Pixabay - Nerve Tendon Gliding',
    source_url: 'https://pixabay.com/videos/yoga-stretches-exercise-people-sea-168352/',
  },
  // [39/41] Pixabay - Finger Tenodesis Hand
  {
    exercise_ids: [107],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/fe3780c5-472d-4970-9fa7-9e6f679549ad.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/c898fb2a-754f-49a5-bceb-5c6dd0caccae.jpg',
    source_name: 'Pixabay - Finger Tenodesis Hand',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148210/',
  },
  // [40/41] Pixabay - Wrist Warmup Yoga
  {
    exercise_ids: [159],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/c34c4711-67be-4068-b0e0-d4a84b1b2ff3.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/4870cc98-7fd0-4ef8-908a-85d587b448cf.jpg',
    source_name: 'Pixabay - Wrist Warmup Yoga',
    source_url: 'https://pixabay.com/videos/woman-yoga-exercise-concentration-129423/',
  },
  // [41/41] Pixabay - Carpal Tunnel Wrist Rehab
  {
    exercise_ids: [177, 180],
    video_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/videos/43484960-3264-4f22-ba54-cfe5e11da9ba.mp4',
    thumbnail_url: 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_96943/images/c6e12454-2cb4-4b06-92ec-30a9c0afd506.jpg',
    source_name: 'Pixabay - Carpal Tunnel Wrist Rehab',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-135159/',
  },
];

async function main() {
  console.log('=== Kinevia — DB Link Videos (Batch 1) ===');
  console.log(`DB: ${DB_URL.replace(/:[^:@]+@/, ':***@')}`);

  const client = await pool.connect();
  let linked = 0, skipped = 0, errors = 0;

  try {
    for (const entry of LINKS) {
      for (const exerciseId of entry.exercise_ids) {
        try {
          // Check exercise exists
          const ex = await client.query('SELECT id FROM exercices WHERE id = $1', [exerciseId]);
          if (ex.rows.length === 0) {
            console.log(`  ⚠ Exercise ${exerciseId} not found — skip`);
            skipped++;
            continue;
          }

          // Check already linked
          const existing = await client.query(
            'SELECT id FROM exercise_videos WHERE exercise_id = $1', [exerciseId]
          );
          if (existing.rows.length > 0) {
            console.log(`  ⏭ #${exerciseId} already linked`);
            skipped++;
            continue;
          }

          // Insert exercise_videos row
          await client.query(
            `INSERT INTO exercise_videos
               (exercise_id, video_url, thumbnail_url, mime_type,
                upload_status, uploaded_by, source, source_url, original_filename)
             VALUES ($1, $2, $3, 'video/mp4', 'ready', $4, 'pixabay', $5, $6)`,
            [exerciseId, entry.video_url, entry.thumbnail_url,
             UPLOADED_BY, entry.source_url, entry.source_name]
          );

          // Update exercices row
          await client.query(
            'UPDATE exercices SET video_url = $1, has_video = TRUE WHERE id = $2',
            [entry.video_url, exerciseId]
          );

          console.log(`  ✓ Linked #${exerciseId}`);
          linked++;
        } catch (err) {
          console.error(`  ✗ Exercise ${exerciseId}: ${err.message}`);
          errors++;
        }
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log('\n════════════════════════════════');
  console.log('DONE');
  console.log(`  ✓ Linked:  ${linked}`);
  console.log(`  ⏭ Skipped: ${skipped}`);
  console.log(`  ✗ Errors:  ${errors}`);
  console.log('════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
