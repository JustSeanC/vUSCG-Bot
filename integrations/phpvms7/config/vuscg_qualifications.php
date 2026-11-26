<?php

return [
    'enabled' => env('VUSCG_QUALIFICATION_SYNC_ENABLED', false),
    // JSON object: each key is a stable qualification code, with explicit id and exact native name.
    'awards' => env('VUSCG_QUALIFICATION_AWARDS', '{}'),
    'rating_enabled' => env('VUSCG_TYPE_RATING_SYNC_ENABLED', false),
    'rating_code_column' => env('VUSCG_TYPE_RATING_CODE_COLUMN'),
    'ip_enabled' => env('VUSCG_IP_ROLE_SYNC_ENABLED', false),
    'ip_role_id' => env('VUSCG_IP_ROLE_ID'),
    'ip_role_name' => env('VUSCG_IP_ROLE_NAME'),
];
