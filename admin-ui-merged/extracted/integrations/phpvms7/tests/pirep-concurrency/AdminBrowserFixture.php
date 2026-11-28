<?php
// Throwaway HTTP harness for the actual patched status method and Blade views.
define('PIREP_FIXTURE_BOOTSTRAP_ONLY', true);
require __DIR__.'/ConcurrencyFixture.php';

use App\Http\Controllers\Admin\PirepController;
use App\Models\Enums\PirepState;
use App\Models\Pirep;
use Illuminate\Filesystem\Filesystem;
use Illuminate\Http\Request;
use Illuminate\Support\HtmlString;
use Illuminate\View\Compilers\BladeCompiler;
use Illuminate\View\Engines\CompilerEngine;
use Illuminate\View\Engines\EngineResolver;
use Illuminate\View\Factory;
use Illuminate\View\FileViewFinder;
use Symfony\Component\HttpKernel\Exception\HttpException;

require $site.'/app/Http/Controllers/Admin/PirepController.php';

if (PHP_SAPI === 'cli' && ($argv[1] ?? null) === 'seed') {
    seedFixture();
    resetFixture();
    exit;
}

class_alias(PirepState::class, 'PirepState');

function abort_if(bool $condition, int $status): void
{
    if ($condition) {
        throw new HttpException($status);
    }
}

function url(string $path): string
{
    return $path;
}

function route(string $name, array $parameters): string
{
    $id = rawurlencode($parameters[0]);
    return match ($name) {
        'admin.pirep.status' => '/admin/pireps/'.$id.'/status',
        'admin.pireps.edit' => '/admin/pireps/'.$id.'/edit',
        'frontend.pireps.show' => '/pireps/'.$id,
        'admin.pireps.destroy' => '/admin/pireps/'.$id,
    };
}

final class Form
{
    public static function open(array $options): HtmlString
    {
        $html = '<form action="'.e($options['url']).'" method="post"';
        foreach (array_diff_key($options, ['url' => null, 'method' => null]) as $key => $value) {
            $html .= ' '.e($key).'="'.e((string) $value).'"';
        }
        $html .= '><input type="hidden" name="_token" value="fixture-csrf">';
        if ($options['method'] !== 'post') {
            $html .= '<input type="hidden" name="_method" value="'.e($options['method']).'">';
        }
        return new HtmlString($html);
    }

    public static function button(string $label, array $options): HtmlString
    {
        $html = '<button';
        foreach ($options as $key => $value) {
            $html .= ' '.e($key).'="'.e($value).'"';
        }
        return new HtmlString($html.'>'.e($label).'</button>');
    }

    public static function close(): HtmlString
    {
        return new HtmlString('</form>');
    }
}

function view(string $name, array $data = []): \Illuminate\View\View
{
    global $views;
    return $views->make($name, $data);
}

$paths = sys_get_temp_dir().'/vuscg-admin-blade';
if (!is_dir($paths.'/admin/scripts')) {
    mkdir($paths.'/admin/scripts', 0700, true);
}
file_put_contents($paths.'/admin/scripts/airport_search.blade.php', '<!-- Fixture airport search include -->');
$files = new Filesystem();
$blade = new BladeCompiler($files, $paths);
$engines = new EngineResolver();
$engines->register('blade', fn () => new CompilerEngine($blade, $files));
$views = new Factory($engines, new FileViewFinder($files, [$site.'/resources/views', $paths]), $events);
$views->setContainer($app);

$request = Request::capture();
$path = $request->getPathInfo();
if ($path === '/fixture/jquery.js') {
    header('Content-Type: application/javascript');
    readfile('/jquery.js');
    exit;
}
if ($path === '/fixture/reset' && $request->isMethod('post')) {
    resetFixture();
    exit;
}
if ($path === '/fixture/health') {
    echo 'ready';
    exit;
}

if (preg_match('#^/admin/pireps/(report[12])/status$#', $path, $matches)) {
    $id = $matches[1];
    $request->setRouteResolver(fn () => new class ($id) {
        public function __construct(private string $id) {}
        public function parameter($name, $default = null) { return $name === 'id' ? $this->id : $default; }
    });
    $reflection = new ReflectionClass(PirepController::class);
    $controller = $reflection->newInstanceWithoutConstructor();
    $reflection->getProperty('pirepSvc')->setValue($controller, $service);
    try {
        abort_if($request->isMethod('post') && $request->post('_token') !== 'fixture-csrf', 419);
        header('Content-Type: text/html; charset=UTF-8');
        echo $controller->status($request)->render();
    } catch (HttpException $error) {
        http_response_code($error->getStatusCode());
        echo 'Fixture request rejected';
    }
    exit;
}

$detail = preg_match('#^/admin/pireps/(report[12])/edit$#', $path, $matches) === 1;
if (!$detail && $path !== '/admin/pireps') {
    http_response_code(404);
    exit;
}

$views->incrementRender();
view('admin.pireps.scripts')->render();
$scripts = $views->yieldContent('scripts');
$views->decrementRender();

header('Content-Type: text/html; charset=UTF-8');
echo '<!doctype html><meta charset="utf-8"><script src="/fixture/jquery.js"></script>';
?>
<script>
window.phpvms = {
  request: async ({ method, url, data }) => {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return { data: await response.text() };
  }
};
window.initPlugins = () => {};
</script>
<?php
foreach ($detail ? [$matches[1]] : ['report1', 'report2'] as $id) {
    $pirep = Pirep::query()->findOrFail($id);
    $state = match ($pirep->state) {
        PirepState::ACCEPTED => 'Accepted',
        PirepState::REJECTED => 'Rejected',
        default => 'Pending',
    };
    echo '<section id="row_'.e($id).'">';
    echo '<div id="pirep_'.e($id).'_status_container"><span>'.e($state).'</span></div>';
    echo '<div id="pirep_'.e($id).'_actionbar">';
    echo view('admin.pireps.actions', ['pirep' => $pirep, 'on_edit_page' => $detail])->render();
    echo '</div></section>';
}
echo $scripts;
