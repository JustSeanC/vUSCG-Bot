<?php
// Small adapters for framework pieces and phpVMS models missing from the audited subset.

namespace App\Contracts {
    class Service {}
    class Event {}
    class Listener {}
    class Notification {}
}

namespace App\Exceptions {
    class PirepError extends \RuntimeException {
        public function __construct($pirep, string $message = 'PIREP refused') { parent::__construct($message); }
    }
    class PirepCancelNotAllowed extends PirepError {}
}

namespace App\Models\Enums {
    class PirepState {
        public const IN_PROGRESS = 0, PENDING = 1, ACCEPTED = 2, CANCELLED = 3, DELETED = 4, DRAFT = 5, REJECTED = 6;
    }
    class PirepStatus { public const ARRIVED = 'ARR', CANCELLED = 'CNL', PAUSED = 'PAU'; }
    class PirepSource { public const ACARS = 1, MANUAL = 0; }
    class AcarsType { public const ROUTE = 1; }
    class AircraftStatus { public const ACTIVE = 'A'; }
    class UserState { public const DELETED = 99; }
}

namespace App\Models {
    use Illuminate\Database\Eloquent\Model;
    use Illuminate\Support\Facades\DB;

    class Record extends Model {
        protected $guarded = [];
        public $timestamps = false;
    }
    class Pirep extends Record {
        use \Illuminate\Database\Eloquent\SoftDeletes;
        public $incrementing = false;
        protected $keyType = 'string';
        public $timestamps = true;
        public static $cancel_states = [2, 3, 4, 6];
        protected $casts = ['block_on_time' => 'datetime', 'submitted_at' => 'datetime'];
        public function aircraft() { return $this->belongsTo(Aircraft::class); }
        public function user() { return $this->belongsTo(User::class); }
        public function getFlightAttribute() { return null; }
        public function getSimbriefAttribute() { return null; }
        public function getBlockFuelAttribute($value) { return new \App\Support\Units\Fuel($value); }
        public function getFuelUsedAttribute($value) { return new \App\Support\Units\Fuel($value); }
        public function getReadOnlyAttribute() { return in_array($this->state, self::$cancel_states, true); }
    }
    class User extends Record {
        public function rank() { return $this->belongsTo(Rank::class); }
        public function notify($message) {
            if (DB::transactionLevel() !== 0) {
                throw new \LogicException('Notification escaped before commit');
            }
            DB::table('fixture_external')->insert(['kind' => $message->kind, 'pirep_id' => $message->pirep->getKey()]);
        }
    }
    class Rank extends Record {
        protected $casts = ['auto_promote' => 'boolean'];
    }
    class Aircraft extends Record {
        protected $table = 'aircraft';
        public function setFuelOnboardAttribute($fuel) { $this->attributes['fuel_onboard'] = $fuel->internal(); }
    }
    class Award extends Record {
        public function getReference($award, $user) {
            return new class ($award->id, $user->id) {
                public function __construct(private int $awardId, private int $userId) {}
                public function handle(): void {
                    DB::table('fixture_awards')->insertOrIgnore(['award_id' => $this->awardId, 'user_id' => $this->userId]);
                }
            };
        }
    }
    class Acars extends Record { protected $table = 'acars'; }
    class PirepComment extends Record { use \Illuminate\Database\Eloquent\SoftDeletes; }
    class PirepFare extends Record { use \Illuminate\Database\Eloquent\SoftDeletes; }
    class PirepFieldValue extends Record { use \Illuminate\Database\Eloquent\SoftDeletes; }
    class SimBrief extends Record { use \Illuminate\Database\Eloquent\SoftDeletes; protected $table = 'simbrief'; }
}

namespace App\Support\Units {
    class Fuel {
        public function __construct(private int $amount) {}
        public static function make($amount, $unit): self { return new self($amount); }
        public function internal(): int { return $this->amount; }
    }
    class Time {
        public int $hours;
        public function __construct(int $minutes) { $this->hours = intdiv($minutes, 60); }
    }
}

namespace App\Services {
    class AirportService {}
    class FareService { public function saveToPirep($pirep, $fares): void {} }
    class GeoService {}
    class SimBriefService {}
}

namespace App\Repositories {
    class AirportRepository {}
    class AircraftRepository {}
    class FlightRepository {}
    class PirepRepository {}
}

namespace App\Services\Finance {
    use Illuminate\Support\Facades\DB;

    class PirepFinanceService {
        public function processFinancesForPirep($pirep): void {
            DB::table('fixture_journal')->insert(['pirep_id' => $pirep->getKey(), 'amount' => 120]);
        }
        public function deleteFinancesForPirep($pirep): void {
            DB::table('fixture_journal')->where('pirep_id', $pirep->getKey())->delete();
        }
    }
}

namespace App\Notifications\Messages {
    class PirepAccepted extends \App\Contracts\Notification {
        public string $kind = 'accepted';
        public function __construct(public object $pirep) {}
    }
    class PirepRejected extends \App\Contracts\Notification {
        public string $kind = 'rejected';
        public function __construct(public object $pirep) {}
    }
}

namespace App\Notifications\Notifiables {
    class Broadcast {}
}
