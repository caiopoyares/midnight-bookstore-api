INSERT INTO books(slug,title,author,genre,synopsis,note,position) VALUES
('hill-house','A assombração da Casa da Colina','Shirley Jackson','Terror gótico','Quatro desconhecidos chegam a uma casa que guarda lembranças. Para Eleanor, o convite parece uma chance de pertencer. A casa parece concordar.','Preste atenção às pequenas crueldades à mesa. Quando as paredes começarem a bater, a casa já estará viva.',1),
('willows','Os salgueiros','Algernon Blackwood','Terror folclórico','Dois viajantes ficam presos em uma ilha do Danúbio. Enquanto a água sobe, os salgueiros começam a se mover contra o vento.','Uma leitura curta para uma noite de ventania. O céu aberto pode ser tão sufocante quanto um quarto fechado.',2),
('carmilla','Carmilla','Sheridan Le Fanu','Terror gótico','Uma visitante fascinante chega a uma propriedade isolada. Laura acolhe sua nova companhia enquanto uma doença misteriosa se espalha pela região.','Uma história íntima e lenta, em que cada gesto de afeto pode esconder uma ameaça.',3),
('king-in-yellow','O Rei de Amarelo','Robert W. Chambers','Terror cósmico','Uma peça proibida atravessa histórias de artistas, cidades perturbadoras e um lugar distante chamado Carcosa. Alguns leitores nunca voltam do segundo ato.','Leia os primeiros contos de uma vez. As pequenas conexões fazem a cidade inteira parecer febril.',4),
('frankenstein','Frankenstein','Mary Shelley','Terror gótico','Victor Frankenstein dá vida a uma criatura e a abandona. A perseguição entre criador e criação vai dos Alpes até as margens do Ártico.','Acompanhe a criatura aprendendo a ler e observando uma família pela fresta da parede.',5),
('turn-of-the-screw','A volta do parafuso','Henry James','Terror psicológico','Uma jovem governanta cuida de duas crianças em uma casa de campo. O que ela vê do outro lado do lago muda a forma como interpreta cada palavra delas.','Leia com alguém. Uma pequena mudança de interpretação pode revelar duas casas completamente diferentes.',6),
('dracula','Drácula','Bram Stoker','Terror gótico','Cartas, diários e notícias revelam a chegada de uma presença antiga à Inglaterra. Um grupo improvável precisa aprender a enfrentar o conde.','Um clássico de ritmo surpreendente, contado pelas vozes de quem tenta entender a ameaça.',7),
('dorian-gray','O retrato de Dorian Gray','Oscar Wilde','Terror psicológico','Um jovem deseja conservar sua beleza enquanto um retrato recebe as marcas de suas escolhas. O desejo cobra um preço.','Observe como a conversa elegante se transforma aos poucos em uma história de horror.',8),
('cthulhu','O chamado de Cthulhu','H. P. Lovecraft','Terror cósmico','Anotações e relatos dispersos levam um investigador a uma presença adormecida e a um culto que atravessa continentes.','Uma investigação feita de fragmentos. Cada descoberta amplia a sensação de insignificância.',9),
('raven','O corvo e outros poemas','Edgar Allan Poe','Terror gótico','Luto, lembranças e visitantes noturnos atravessam esta seleção de poemas de um dos grandes nomes da literatura de horror.','Leia em voz alta para perceber o peso das repetições e o ritmo das imagens.',10),
('monkey-paw','A pata do macaco','W. W. Jacobs','Terror sobrenatural','Um objeto trazido de longe promete realizar três desejos. Uma família descobre que até o pedido mais simples pode ter consequências terríveis.','Uma sala comum, uma noite de chuva e três desejos bastam para construir o medo.',11),
('horror-dunwich','O horror de Dunwich','H. P. Lovecraft','Terror cósmico','Uma família isolada, um nascimento estranho e livros proibidos anunciam uma ameaça nas colinas de Dunwich.','Uma paisagem rural em que cada detalhe parece esconder algo maior.',12)
ON CONFLICT(slug) DO UPDATE SET title=excluded.title,author=excluded.author,genre=excluded.genre,synopsis=excluded.synopsis,note=excluded.note;
INSERT INTO editions(sku,book_slug,format,price,on_hand) VALUES
('HILL-PB','hill-house','Paperback',5990,12),('HILL-HC','hill-house','Capa dura',8990,1),
('WILL-PB','willows','Paperback',3990,9),('CARM-HC','carmilla','Capa dura',7990,5),
('KING-PB','king-in-yellow','Paperback',4990,8),('FRAN-PB','frankenstein','Paperback',5490,11),
('FRAN-HC','frankenstein','Capa dura',8490,0),('TURN-PB','turn-of-the-screw','Paperback',4490,7)
ON CONFLICT DO NOTHING;
INSERT INTO editions(sku,book_slug,format,price,on_hand) VALUES
('DRAC-PB','dracula', 'Paperback',5990,12),
('DOR-PB','dorian-gray', 'Paperback',4990,7),
('CTHU-PB','cthulhu', 'Paperback',3490,10),
('RAV-HC','raven', 'Capa dura',6990,6),
('PAW-PB','monkey-paw', 'Paperback',2990,9),
('DUN-PB','horror-dunwich', 'Paperback',3990,8)
ON CONFLICT DO NOTHING;
