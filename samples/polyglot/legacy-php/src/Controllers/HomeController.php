<?php
namespace App\Controllers;

use App\Models\Page;

require_once __DIR__ . '/../helpers.php';

class HomeController
{
    public function show(string $slug): string
    {
        $page = Page::find($slug);
        if ($page === null) {
            throw new \RuntimeException("not found");
        }
        return render($page);
    }
}
