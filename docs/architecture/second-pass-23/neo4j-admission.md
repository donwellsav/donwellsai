# Graphiti server admission

Selected separate local Neo4j Community 5.26.30 LTS server for the pinned Graphiti0.30.1 Neo4j driver. Official deployment center lists this LTS maintenance release (26 August2026): https://neo4j.com/deployment-center/ . Exact upstream license is GPLv3: https://raw.githubusercontent.com/neo4j/neo4j/5.26.30/LICENSE.txt . Graphiti remains Apache2; its license does not cover the database.

This local server is an independently configured Docker service, not embedded or redistributed in the desktop application. Preserve the server's upstream notices. No Enterprise features or license acceptance. Intended actual trial: dedicated container/volume, localhost-only Bolt, 2CPU/2GiB limit, 512MiB heap and 256MiB page cache, unique temporary authentication, no mounts of user projects. Record image digest and packaged license before launch. Remove only task-owned container after qualification.

Actual image: `neo4j@sha256:037cf5756f0135cbfd66b739b6df7c7c4bb100f9ce11602f6f9538e17e02c74d`. Before starting, copied packaged LICENSE.txt, LICENSES.txt and NOTICE.txt from a never-started owned container. Packaged license SHA256: 03006025fde1e53f3005594f09ef9a9152958a6c62f294524b062455e4778160. Files retained at `/tmp/donwells-neo4j-{LICENSE,LICENSES,NOTICE}.txt` for this local trial.
