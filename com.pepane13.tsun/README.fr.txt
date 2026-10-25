Suivez votre micro-onduleur TSUN directement dans Homey, sur votre réseau local, sans passer par le cloud TSUN.

L'app interroge le logger Wi-Fi Solarman de l'onduleur (LSW-3 / LSW-5, port TCP 8899) toutes les 30 secondes. Elle fonctionne en lecture seule : aucune commande n'est envoyée à l'onduleur.

Fonctions :
- Intégration à Homey Énergie : l'onduleur apparaît comme panneau solaire, avec la production instantanée et le compteur de production totale
- Tension, courant et fréquence réseau, température de l'onduleur, alarme et statut détaillé
- Puissance et production du jour de chacun des 6 panneaux
- Widget de tableau de bord : vos panneaux dessinés selon leur disposition sur le toit (ordre et colonnes réglables) avec leur production en direct et la production habituelle à cette heure, et un bandeau avec puissance, production du jour et totale, pic du jour, réseau, température, rendement DC→AC et liaison logger
- Cartes Flow : un panneau est sous-performant (par rapport à la moyenne des autres, seuil et durée réglables), un panneau est revenu à la normale, le statut de l'onduleur a changé
- Diagnostic dans les réglages de l'app : analyse Wi-Fi avec cause probable, courbe du temps de réponse du logger, alertes de perte de communication, panneau qui ne produit pas, alertes tension réseau et température, bilan quotidien et journal de diagnostic copiable
- Surveillance adaptative des panneaux : chaque panneau est comparé à sa propre production habituelle à cette heure, apprise automatiquement ; les ombrages récurrents ne déclenchent pas d'alerte

Compatibilité : validée sur le TSUN TSOL-MX3000D (6 entrées). Les autres modèles TSUN 6-en-1 utilisant la même table de registres devraient fonctionner mais n'ont pas été testés.

Avant d'ajouter l'appareil :
- Relevez l'adresse IP du logger dans votre box et attribuez-lui une adresse fixe (bail DHCP statique)
- Notez le numéro de série du logger à 10 chiffres (« Device serial number » sur l'étiquette ou la page web du logger)
- Ajoutez l'appareil en journée : l'onduleur est alimenté par les panneaux et s'éteint la nuit

La nuit, l'onduleur ne répond plus : la production passe à 0, le statut indique « Veille (nuit) » et l'app l'interroge toutes les 5 minutes jusqu'au matin.

Conseil de sécurité : le port du logger n'est protégé que par son numéro de série. Gardez le logger sur un réseau de confiance ou un VLAN IoT n'autorisant que Homey en TCP 8899, et changez le mot de passe par défaut de son interface web.

Cette app n'est ni affiliée à TSUN ou Solarman, ni approuvée par eux.
