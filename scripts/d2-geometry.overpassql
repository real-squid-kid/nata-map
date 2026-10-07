[out:json][timeout:60][maxsize:16777216];
// D2: Nakhabino -> Podolsk. Only track ways of one route, no platforms/nodes.
relation(10309306)->.d2;
way(r.d2:"")["railway"="rail"];
out skel geom;
