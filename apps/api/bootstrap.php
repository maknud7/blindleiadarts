<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$configFile=__DIR__.'/config.php';
if(!is_file($configFile))throw new RuntimeException('Missing apps/api/config.php. Generate or copy it before running the API.');
/** @var array<string,mixed> $config */
$config=require $configFile; $dbc=$config['db']??null;
if(!is_array($dbc))throw new RuntimeException('Missing database configuration.');
$prefix=(string)($dbc['table_prefix']??''); if(!preg_match('/^[A-Za-z0-9_]+$/',$prefix))throw new RuntimeException('Invalid database table prefix.');
$db=new mysqli((string)$dbc['host'],(string)$dbc['username'],(string)$dbc['password'],(string)$dbc['database'],(int)($dbc['port']??3306)); $db->set_charset('utf8mb4');
require_once dirname(__DIR__,2).'/packages/connectors/dartsatlas/DartsAtlasLiveAdapter.php';
$da=is_array($config['dartsatlas']??null)?$config['dartsatlas']:[];
$http=new DartsAtlasHttpClient((string)($da['base_url']??'https://www.dartsatlas.com'));
$parser=new DartsAtlasParser(); $members=new BlindleiaMemberDirectory($db,(string)($config['member_table']??'medlemmer'));
$adapter=new DartsAtlasLiveAdapter($db,$prefix,$http,$parser,$members);
return ['config'=>$config,'db'=>$db,'prefix'=>$prefix,'adapter'=>$adapter];
