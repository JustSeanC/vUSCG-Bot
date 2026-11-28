{{-- Include inside each PIREP action group. Give the group the data-vuscg-pirep-review attribute. --}}
<input type="hidden" name="review_revision"
       value="{{ $vuscgReviewRevision ?? \App\Services\PirepService::reviewRevision($pirep) }}">
@if (!empty($vuscgReviewConflict))
    <p role="status">This PIREP changed before your decision was saved. Review its current state and choose again.</p>
@endif
